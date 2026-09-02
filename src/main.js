/**
 * Sports Module Rundown — Companion connection
 * Calls Edge Function rundown-companion (list + transport + cue poll).
 */
const { InstanceBase, runEntrypoint, InstanceStatus, combineRgb } = require('@companion-module/base')
const UpgradeScripts = require('./upgrades')
const Defaults = require('./defaults')

const CUE_POLL_MS = 500
// Fallback path only: the poll_cues op carries no live state, so every Nth tick
// also refreshes the doc list. The REST path gets live state on every tick.
const LIVE_POLL_EVERY = 4
// Beats are ~2 KB; refetch them at most this often when the doc's updated_at moves.
const BEATS_REFETCH_MS = 5000
// Columns of the rundown_documents row the live poll needs.
const DOC_COLS = 'id,title,live_active,live_paused,live_current_idx,updated_at,environment_id'
const CUE_COLS = 'seq,cue_number,cue_name,line_text,trigger_id,event_id,offset_sec,created_at'

class SportsModuleRundownInstance extends InstanceBase {
	constructor(internal) {
		super(internal)
		this.config = {}
		this.secrets = {}
		this.docs = []
		this.accessToken = ''
		this.refreshToken = ''
		this.tokenExpiresAt = 0
		this.cueAfterSeq = null
		this.pollTimer = null
		this.pollTicks = 0
		this.lastLivePublish = null
		this.lastChoiceSig = ''
		this.restAvailable = true
		this.restWarned = false
		this.beats = []
		this.beatsDocId = ''
		this.beatsUpdatedAt = ''
		this.beatsFetchedAt = 0
		this.columns = []
		this.columnsEnvId = ''
		this.prevLiveActive = null
		this.prevPublishedDocId = ''
		this.lastCueNumber = 0
		this.lastCueName = ''
		this.lastCueEventId = ''
		this.lastCueLineText = ''
		this.lastCueTriggerId = ''
		this.lastCueAt = ''
		this.pollInFlight = false
	}

	async init(config, _isFirstInit, secrets) {
		this.config = config || {}
		this.secrets = secrets || {}
		this.updateActions()
		this.updateFeedbacks()
		this.updateVariableDefinitions()
		this.updatePresets()
		await this.connectAndLoad()
	}

	async destroy() {
		this.stopPolling()
		this.accessToken = ''
		this.refreshToken = ''
		this.docs = []
	}

	async configUpdated(config, secrets) {
		this.config = config || {}
		this.secrets = secrets || {}
		this.lastLivePublish = null
		// A rundown swap must not carry the previous show's cue over.
		this.resetCueState()
		await this.connectAndLoad()
	}

	getConfigFields() {
		const choices = this.getRundownChoices()
		return [
			{
				type: 'static-text',
				id: 'info',
				width: 12,
				label: 'Sports Module Rundown',
				value:
					'Sign in as an org member. Pick a rundown (live shows are marked). Uses the Sports Module cloud by default. Cue fires update variables + feedbacks.' +
					`<br />Web app: <a href="${Defaults.HUB_URL}" target="_blank" rel="noreferrer">${Defaults.HUB_URL}</a> — create rundowns and Go live there first.`,
			},
			{
				type: 'textinput',
				id: 'email',
				label: 'Member email',
				width: 6,
				default: '',
			},
			{
				type: 'secret-text',
				id: 'password',
				label: 'Password',
				width: 6,
				default: '',
			},
			{
				type: 'dropdown',
				id: 'docId',
				label: 'Rundown',
				width: 12,
				default: choices[0] ? choices[0].id : '',
				choices,
			},
			{
				type: 'checkbox',
				id: 'useAdvancedCloud',
				label: 'Advanced: override cloud endpoint (staging)',
				width: 12,
				default: false,
			},
			{
				type: 'static-text',
				id: 'advancedInfo',
				width: 12,
				label: 'Advanced',
				value:
					'Leave empty to use the built-in Sports Module production cloud. Fill both fields only for staging / custom projects.',
				isVisibleExpression: 'Boolean($(options:useAdvancedCloud))',
			},
			{
				type: 'textinput',
				id: 'supabaseUrl',
				label: 'Supabase URL (override)',
				width: 12,
				default: '',
				tooltip: 'https://YOUR_PROJECT.supabase.co',
				isVisibleExpression: 'Boolean($(options:useAdvancedCloud))',
			},
			{
				type: 'textinput',
				id: 'anonKey',
				label: 'Supabase anon key (override)',
				width: 12,
				default: '',
				isVisibleExpression: 'Boolean($(options:useAdvancedCloud))',
			},
		]
	}

	memberPassword() {
		const fromSecrets = this.secrets && this.secrets.password != null ? String(this.secrets.password) : ''
		if (fromSecrets) return fromSecrets
		// Legacy connections stored password in config (pre-0.3.0).
		return String((this.config && this.config.password) || '')
	}

	baseUrl() {
		const advanced = !!(this.config && this.config.useAdvancedCloud)
		const override = String((this.config && this.config.supabaseUrl) || '')
			.trim()
			.replace(/\/$/, '')
		if (advanced && override) return override
		return String(Defaults.SUPABASE_URL || '')
			.trim()
			.replace(/\/$/, '')
	}

	anonKey() {
		const advanced = !!(this.config && this.config.useAdvancedCloud)
		const override = String((this.config && this.config.anonKey) || '').trim()
		if (advanced && override) return override
		return String(Defaults.SUPABASE_ANON_KEY || '').trim()
	}

	async connectAndLoad() {
		this.stopPolling()
		const url = this.baseUrl()
		const anon = this.anonKey()
		const email = String((this.config && this.config.email) || '').trim()
		const password = this.memberPassword()

		if (!url || !anon) {
			this.updateStatus(InstanceStatus.BadConfig, 'Cloud URL / anon key missing')
			return
		}
		if (!email || !password) {
			this.updateStatus(InstanceStatus.BadConfig, 'Fill email and password')
			return
		}

		this.updateStatus(InstanceStatus.Connecting)

		try {
			await this.ensureAuth(true)
			// Re-probe direct table access on every (re)connect.
			this.restAvailable = true
			this.restWarned = false
			this.resetCueState()
			await this.refreshDocList()
			await this.primeCueSeq()
			await this.refreshBeats(true)
			// Seed the transition detector so the first publish is not read as a
			// doc change and does not re-prime the seq we just fetched.
			this.prevPublishedDocId = this.selectedDocId()
			this.prevLiveActive = null
			this.updateActions()
			this.updateFeedbacks()
			this.updatePresets()
			this.publishLiveState()
			this.setCueVariables()
			this.setVariableValues({ last_action: '', last_error: '' })
			this.updateStatus(InstanceStatus.Ok)
			this.startPolling()
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e)
			this.setVariableValues({ last_error: msg })
			this.updateStatus(InstanceStatus.ConnectionFailure, msg)
			this.log('error', msg)
		}
	}

	async ensureAuth(force) {
		const now = Date.now()
		if (!force && this.accessToken && this.tokenExpiresAt > now + 30_000) {
			return
		}

		const url = this.baseUrl()
		const anon = this.anonKey()
		const email = String((this.config && this.config.email) || '').trim()
		const password = this.memberPassword()

		const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
			method: 'POST',
			headers: {
				apikey: anon,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ email, password }),
		})
		const data = await res.json().catch(() => ({}))
		if (!res.ok || !data.access_token) {
			throw new Error(
				(data && (data.error_description || data.msg || data.error)) || `Login failed (HTTP ${res.status})`,
			)
		}
		this.accessToken = String(data.access_token)
		this.refreshToken = String(data.refresh_token || '')
		const expiresIn = Math.max(60, Math.floor(Number(data.expires_in) || 3600))
		this.tokenExpiresAt = Date.now() + expiresIn * 1000
	}

	getRundownChoices() {
		if (!this.docs || !this.docs.length) {
			return [{ id: '', label: '(Save connection to load rundowns)' }]
		}
		return this.docs.map((d) => {
			const flags = []
			if (d.liveActive) flags.push(d.livePaused ? 'LIVE paused' : 'LIVE')
			const tag = flags.length ? ` [${flags.join(', ')}]` : ''
			return {
				id: String(d.id),
				label: `${d.title || d.id}${tag}`,
			}
		})
	}

	updateVariableDefinitions() {
		this.setVariableDefinitions([
			{ variableId: 'doc_id', name: 'Selected rundown id' },
			{ variableId: 'rundown_title', name: 'Selected rundown title' },
			{ variableId: 'live_active', name: 'Selected rundown is live (true/false)' },
			{ variableId: 'live_paused', name: 'Selected rundown is paused (true/false)' },
			{ variableId: 'live_current_idx', name: 'Current live beat index' },
			{ variableId: 'live_current_name', name: 'Current live beat name' },
			{ variableId: 'last_action', name: 'Last successful transport action' },
			{ variableId: 'last_error', name: 'Last error message' },
			{ variableId: 'last_cue_number', name: 'Last fired cue number (1-16)' },
			{ variableId: 'last_cue_name', name: 'Last fired cue name' },
			{ variableId: 'last_cue_event_id', name: 'Last fired line event id' },
			{ variableId: 'last_cue_line_text', name: 'Last fired line text' },
			{ variableId: 'last_cue_trigger_id', name: 'Last fired trigger id' },
			{ variableId: 'last_cue_at', name: 'Last fired cue time (ISO)' },
		])
	}

	// this.docs is the single mirror of server-reported live state: the list poll
	// replaces it wholesale, transport replies merge into it.
	liveStateFor(docId) {
		const id = String(docId || '')
		if (!id) return null
		return (this.docs || []).find((d) => String(d.id) === id) || null
	}

	publishLiveState() {
		const docId = this.selectedDocId()
		const live = this.liveStateFor(docId)
		const active = !!(live && live.liveActive)

		// "Reset to top" is performed in the hub by ending the show and going live
		// again, so a false->true transition is the signal to drop the previous
		// show's cue. A doc swap is the other boundary.
		const docChanged = docId !== this.prevPublishedDocId
		const wentLive = this.prevLiveActive === false && active
		this.prevLiveActive = active
		this.prevPublishedDocId = docId
		if (wentLive || docChanged) {
			this.resetCueState()
			this.primeCueSeq().catch(() => {})
		}

		const values = {
			rundown_title: (live && live.title) || '',
			live_active: String(active),
			live_paused: String(!!(live && live.livePaused)),
			live_current_idx: live && live.liveCurrentIdx != null ? String(live.liveCurrentIdx) : '',
			live_current_name: this.currentBeatName(live),
			doc_id: docId,
		}

		// Runs on every 500 ms tick; stay silent when nothing moved.
		const sig = JSON.stringify(values)
		if (sig === this.lastLivePublish) return
		this.lastLivePublish = sig

		this.setVariableValues(values)
		this.checkFeedbacks('live_is_paused', 'live_is_active')
	}

	// Cue state is per-show: clearing it must also drop the feedback, or a Cue button
	// stays lit on a cue that fired in a previous show.
	resetCueState() {
		this.cueAfterSeq = null
		this.lastCueNumber = 0
		this.lastCueName = ''
		this.lastCueEventId = ''
		this.lastCueLineText = ''
		this.lastCueTriggerId = ''
		this.lastCueAt = ''
		this.setCueVariables()
		this.checkFeedbacks('last_cue_is')
	}

	setCueVariables() {
		this.setVariableValues({
			last_cue_number: this.lastCueNumber ? String(this.lastCueNumber) : '',
			last_cue_name: this.lastCueName || '',
			last_cue_event_id: this.lastCueEventId || '',
			last_cue_line_text: this.lastCueLineText || '',
			last_cue_trigger_id: this.lastCueTriggerId || '',
			last_cue_at: this.lastCueAt || '',
		})
	}

	async callCompanion(body) {
		await this.ensureAuth(false)
		const url = `${this.baseUrl()}/functions/v1/rundown-companion`
		const anon = this.anonKey()

		const doFetch = async (token) =>
			fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${token}`,
					apikey: anon,
				},
				body: JSON.stringify(body),
			})

		let res = await doFetch(this.accessToken)
		if (res.status === 401) {
			await this.ensureAuth(true)
			res = await doFetch(this.accessToken)
		}

		const data = await res.json().catch(() => ({}))
		if (!res.ok) {
			throw new Error((data && data.error) || `HTTP ${res.status}`)
		}
		return data
	}

	// Direct PostgREST read. The edge function is the documented contract, but it
	// cannot serve live state cheaply (op:'list' returns every doc in the org) and
	// exposes no beat list at all. Reading the tables straight gives both in one
	// ~140 B request — at the cost of depending on table names and RLS that are not
	// a published contract, so every caller must tolerate restUnavailable().
	async callRest(pathAndQuery) {
		await this.ensureAuth(false)
		const url = `${this.baseUrl()}/rest/v1/${pathAndQuery}`
		const anon = this.anonKey()

		const doFetch = async (token) =>
			fetch(url, {
				headers: {
					apikey: anon,
					Authorization: `Bearer ${token}`,
					Accept: 'application/json',
				},
			})

		let res = await doFetch(this.accessToken)
		if (res.status === 401) {
			await this.ensureAuth(true)
			res = await doFetch(this.accessToken)
		}
		if (!res.ok) {
			const err = new Error(`REST HTTP ${res.status}`)
			err.status = res.status
			throw err
		}
		return res.json()
	}

	// RLS may not grant every operator the table access this account has. Degrade to
	// the edge-function path rather than breaking; re-probed on the next connect.
	restUnavailable(e) {
		const status = e && e.status
		if (status === 401 || status === 403 || status === 404 || status === 406) {
			this.restAvailable = false
			if (!this.restWarned) {
				this.restWarned = true
				this.log('info', `Direct table read unavailable (HTTP ${status}); using slower edge-function polling`)
			}
			return true
		}
		return false
	}

	async fetchDocs() {
		const data = await this.callCompanion({ op: 'list' })
		return Array.isArray(data.docs) ? data.docs : []
	}

	async refreshDocList() {
		this.docs = await this.fetchDocs()
		this.lastChoiceSig = this.choiceSignature()
		this.log('info', `Loaded ${this.docs.length} rundown(s)`)
		this.updateActions()
	}

	// Rebuilding action/config dropdowns on every live poll would churn the UI, so
	// only do it when the visible choices actually changed.
	choiceSignature() {
		return (this.docs || []).map((d) => `${d.id}|${d.title}|${!!d.liveActive}|${!!d.livePaused}`).join('\n')
	}

	async refreshLiveState() {
		this.docs = await this.fetchDocs()
		this.publishLiveState()
		const sig = this.choiceSignature()
		if (sig !== this.lastChoiceSig) {
			this.lastChoiceSig = sig
			this.updateActions()
		}
	}

	selectedDocId() {
		return String((this.config && this.config.docId) || '').trim()
	}

	// Seed cueAfterSeq with the current max so the backlog is discarded, matching the
	// edge-function behaviour. seq is monotonic per document and does NOT reset when a
	// show restarts, so resetting to 0 would replay the entire history.
	async primeCueSeq() {
		const docId = this.selectedDocId()
		this.cueAfterSeq = null
		if (!docId || !this.restAvailable) return
		try {
			const rows = await this.callRest(
				`rundown_companion_cue_events?document_id=eq.${encodeURIComponent(docId)}&select=seq&order=seq.desc&limit=1`,
			)
			this.cueAfterSeq = rows && rows.length ? Math.floor(Number(rows[0].seq) || 0) : 0
		} catch (e) {
			if (!this.restUnavailable(e)) throw e
		}
	}

	async refreshBeats(force) {
		const docId = this.selectedDocId()
		if (!docId || !this.restAvailable) return
		if (!force && Date.now() - this.beatsFetchedAt < BEATS_REFETCH_MS) return
		try {
			const rows = await this.callRest(
				`rundown_documents?id=eq.${encodeURIComponent(docId)}&select=updated_at,environment_id,events`,
			)
			const row = rows && rows[0]
			if (!row) return
			this.beats = Array.isArray(row.events) ? row.events : []
			this.beatsDocId = docId
			this.beatsUpdatedAt = String(row.updated_at || '')
			this.beatsFetchedAt = Date.now()
			await this.refreshColumns(row.environment_id)
		} catch (e) {
			if (!this.restUnavailable(e)) throw e
		}
	}

	// Cell order comes from the environment's column definitions, not the cells object.
	async refreshColumns(envId) {
		const id = String(envId || '')
		if (!id || id === this.columnsEnvId || !this.restAvailable) return
		try {
			const rows = await this.callRest(`rundown_environments?id=eq.${encodeURIComponent(id)}&select=settings`)
			const settings = (rows && rows[0] && rows[0].settings) || {}
			const cols = Array.isArray(settings.columns) ? settings.columns.slice() : []
			cols.sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0))
			this.columns = cols
			this.columnsEnvId = id
		} catch (e) {
			if (!this.restUnavailable(e)) throw e
		}
	}

	// Mirrors the hub's own label convention, as observed in the cue log:
	// blockId "studio" + cells {Gæster:"Jan", Cam:"Cam 2"} -> "STUDIO — Jan".
	// Cells win over `what`/`cue`; no observed beat had both, so if one ever formats
	// differently from the hub, this precedence is the single line to change.
	elementLabel(el, idx) {
		if (!el) return ''
		if (el.kind === 'chapter') return String(el.title || '') || `Item ${idx + 1}`

		const cells = el.cells && typeof el.cells === 'object' ? el.cells : {}
		let cell = ''
		for (const col of this.columns) {
			const v = String(cells[col.id] || '').trim()
			if (v) {
				cell = v
				break
			}
		}
		// No column definitions cached (or none matched): fall back to insertion order.
		if (!cell) {
			cell = String(Object.values(cells).find((v) => String(v || '').trim()) || '').trim()
		}

		const detail = cell || String(el.what || '').trim() || String(el.cue || '').trim()
		const block = String(el.blockId || '')
			.trim()
			.toUpperCase()
		if (block && detail) return `${block} — ${detail}`
		return block || detail || `Item ${idx + 1}`
	}

	currentBeatName(live) {
		if (!live) return ''
		const idx = Math.floor(Number(live.liveCurrentIdx))
		// -1 is the server's "not live / no position" value.
		if (!Number.isFinite(idx) || idx < 0) return ''
		if (this.beatsDocId !== this.selectedDocId()) return ''
		if (idx >= this.beats.length) return ''
		return this.elementLabel(this.beats[idx], idx)
	}

	stopPolling() {
		if (this.pollTimer) {
			clearInterval(this.pollTimer)
			this.pollTimer = null
		}
		this.pollInFlight = false
	}

	startPolling() {
		this.stopPolling()
		const docId = this.selectedDocId()
		if (!docId) return
		this.pollTicks = 0
		this.pollTimer = setInterval(() => {
			this.pollTick().catch((e) => {
				const msg = e instanceof Error ? e.message : String(e)
				this.log('debug', `poll: ${msg}`)
			})
		}, CUE_POLL_MS)
		this.pollTick().catch(() => {})
	}

	// One timer, one request in flight: a second interval would let two calls race on
	// a token refresh in ensureAuth().
	async pollTick() {
		if (this.pollInFlight) return
		this.pollInFlight = true
		try {
			if (this.restAvailable) {
				await this.pollRest()
			}
			// Not an else: pollRest() may have just given up on the REST path.
			if (!this.restAvailable) {
				await this.pollCues()
				if (this.pollTicks % LIVE_POLL_EVERY === 0) {
					await this.refreshLiveState()
				}
			}
			this.pollTicks++
		} finally {
			this.pollInFlight = false
		}
	}

	// The hot path: one request carries live state and any new cue events.
	async pollRest() {
		const docId = this.selectedDocId()
		if (!docId) return
		const id = encodeURIComponent(docId)
		const after = this.cueAfterSeq != null ? this.cueAfterSeq : 0
		const query =
			`rundown_documents?id=eq.${id}` +
			`&select=${DOC_COLS},rundown_companion_cue_events(${CUE_COLS})` +
			`&rundown_companion_cue_events.seq=gt.${after}` +
			`&rundown_companion_cue_events.order=seq.asc`

		let rows
		try {
			rows = await this.callRest(query)
		} catch (e) {
			if (this.restUnavailable(e)) return
			throw e
		}

		const row = rows && rows[0]
		if (!row) return

		// Feed the same camelCase mirror the edge-function path writes, so
		// liveStateFor()/publishLiveState() stay unchanged.
		const live = {
			id: String(row.id),
			title: row.title,
			liveActive: !!row.live_active,
			livePaused: !!row.live_paused,
			liveCurrentIdx: row.live_current_idx,
			updatedAt: row.updated_at,
		}
		const known = (this.docs || []).some((d) => String(d.id) === live.id)
		this.docs = known
			? (this.docs || []).map((d) => (String(d.id) === live.id ? { ...d, ...live } : d))
			: [...(this.docs || []), live]

		// Beats only change when the doc is edited; the name resolves from cache on
		// every idx move, so this stays off the hot path.
		if (String(row.updated_at || '') !== this.beatsUpdatedAt || this.beatsDocId !== docId) {
			await this.refreshBeats(this.beatsDocId !== docId)
		}

		this.publishLiveState()

		const events = Array.isArray(row.rundown_companion_cue_events) ? row.rundown_companion_cue_events : []
		if (this.cueAfterSeq == null) {
			// Priming failed earlier; adopt the current max rather than replaying.
			this.cueAfterSeq = events.length ? Math.floor(Number(events[events.length - 1].seq) || 0) : 0
			return
		}
		if (!events.length) return

		for (const ev of events) {
			this.applyCueEvent({
				cueNumber: ev.cue_number,
				cueName: ev.cue_name,
				eventId: ev.event_id,
				lineText: ev.line_text,
				triggerId: ev.trigger_id,
				createdAt: ev.created_at,
			})
		}
		const last = events[events.length - 1]
		this.cueAfterSeq = Math.max(this.cueAfterSeq, Math.floor(Number(last && last.seq) || 0))
		this.checkFeedbacks('last_cue_is')
	}

	async pollCues() {
		const docId = this.selectedDocId()
		if (!docId) return
		const body = { op: 'poll_cues', docId }
		if (this.cueAfterSeq != null) {
			body.afterSeq = this.cueAfterSeq
		}
		const data = await this.callCompanion(body)
		const latestSeq = Math.max(0, Math.floor(Number(data.latestSeq) || 0))
		const events = Array.isArray(data.events) ? data.events : []

		if (this.cueAfterSeq == null) {
			this.cueAfterSeq = latestSeq
			return
		}

		if (!events.length) {
			if (latestSeq > this.cueAfterSeq) this.cueAfterSeq = latestSeq
			return
		}

		for (const ev of events) {
			this.applyCueEvent(ev)
		}
		const last = events[events.length - 1]
		this.cueAfterSeq = Math.max(this.cueAfterSeq, Math.floor(Number(last && last.seq) || 0), latestSeq)
		this.checkFeedbacks('last_cue_is')
	}

	applyCueEvent(ev) {
		if (!ev) return
		const n = Math.floor(Number(ev.cueNumber) || 0)
		this.lastCueNumber = n >= 1 && n <= 16 ? n : 0
		this.lastCueName = String(ev.cueName || '') || (this.lastCueNumber ? `Cue ${this.lastCueNumber}` : '')
		this.lastCueEventId = String(ev.eventId || '')
		this.lastCueLineText = String(ev.lineText || '')
		this.lastCueTriggerId = String(ev.triggerId || '')
		this.lastCueAt = String(ev.createdAt || '')
		this.setCueVariables()
		this.log('info', `Cue ${this.lastCueNumber}${this.lastCueName ? ` (${this.lastCueName})` : ''} fired`)
	}

	updateFeedbacks() {
		this.setFeedbackDefinitions({
			last_cue_is: {
				type: 'boolean',
				name: 'Last cue is number',
				description: 'True when the last fired companion cue matches this number',
				defaultStyle: {
					bgcolor: combineRgb(0, 160, 60),
					color: combineRgb(255, 255, 255),
				},
				options: [
					{
						type: 'number',
						id: 'cueNumber',
						label: 'Cue number',
						default: 1,
						min: 1,
						max: 16,
					},
				],
				callback: (feedback) => {
					const want = Math.floor(Number(feedback.options && feedback.options.cueNumber) || 0)
					return want >= 1 && want <= 16 && this.lastCueNumber === want
				},
			},
			live_is_active: {
				type: 'boolean',
				name: 'Selected rundown is live',
				description: 'True while the selected rundown is live (paused or not)',
				defaultStyle: {
					bgcolor: combineRgb(0, 160, 60),
					color: combineRgb(255, 255, 255),
				},
				options: [],
				callback: () => {
					const live = this.liveStateFor(this.selectedDocId())
					return !!(live && live.liveActive)
				},
			},
			live_is_paused: {
				type: 'boolean',
				name: 'Selected rundown is paused',
				description: 'True while the selected rundown is live and paused',
				defaultStyle: {
					bgcolor: combineRgb(200, 140, 0),
					color: combineRgb(255, 255, 255),
				},
				options: [],
				callback: () => {
					const live = this.liveStateFor(this.selectedDocId())
					return !!(live && live.livePaused)
				},
			},
		})
	}

	updatePresets() {
		const presets = {}

		const transport = [
			{ id: 'previous', label: 'Previous', feedbacks: [] },
			{ id: 'pause', label: 'Pause', feedbacks: ['live_is_paused'] },
			{ id: 'resume', label: 'Resume', feedbacks: [] },
			{ id: 'next', label: 'Next', feedbacks: [] },
		]
		for (const t of transport) {
			presets[`transport_${t.id}`] = {
				type: 'button',
				category: 'Transport',
				name: t.label,
				style: {
					text: t.label,
					size: '18',
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(30, 30, 30),
				},
				steps: [
					{
						down: [{ actionId: t.id, options: { docId: this.selectedDocId() } }],
						up: [],
					},
				],
				feedbacks: t.feedbacks.map((feedbackId) => ({
					feedbackId,
					options: {},
					style: {
						bgcolor: combineRgb(200, 140, 0),
						color: combineRgb(255, 255, 255),
					},
				})),
			}
		}

		for (let i = 1; i <= 16; i++) {
			presets[`cue_${i}`] = {
				type: 'button',
				category: 'Companion cues',
				name: `Cue ${i}`,
				style: {
					text: `Cue ${i}`,
					size: '18',
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(30, 30, 30),
				},
				steps: [
					{
						down: [],
						up: [],
					},
				],
				feedbacks: [
					{
						feedbackId: 'last_cue_is',
						options: { cueNumber: i },
						style: {
							bgcolor: combineRgb(0, 160, 60),
							color: combineRgb(255, 255, 255),
						},
					},
				],
			}
		}
		this.setPresetDefinitions(presets)
	}

	updateActions() {
		const choices = this.getRundownChoices()
		const defaultDoc = this.selectedDocId() || (choices[0] && choices[0].id) || ''

		const docOption = {
			type: 'dropdown',
			id: 'docId',
			label: 'Rundown',
			default: defaultDoc,
			choices,
		}

		this.setActionDefinitions({
			refresh_list: {
				name: 'Refresh rundown list',
				options: [],
				callback: async () => {
					try {
						await this.refreshDocList()
						this.publishLiveState()
						this.updateStatus(InstanceStatus.Ok)
						this.setVariableValues({ last_action: 'refresh_list', last_error: '' })
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e)
						this.setVariableValues({ last_error: msg })
						this.log('error', msg)
					}
				},
			},
			previous: {
				name: 'Previous',
				options: [docOption],
				callback: async (event) => this.runTransport('previous', event),
			},
			pause: {
				name: 'Pause',
				options: [docOption],
				callback: async (event) => this.runTransport('pause', event),
			},
			resume: {
				name: 'Resume',
				options: [docOption],
				callback: async (event) => this.runTransport('resume', event),
			},
			next: {
				name: 'Next',
				options: [docOption],
				callback: async (event) => this.runTransport('next', event),
			},
		})
	}

	async runTransport(action, event) {
		const fromOpts = event && event.options && event.options.docId
		const docId = String(fromOpts || this.selectedDocId() || '').trim()
		if (!docId) {
			const msg = 'No rundown selected'
			this.setVariableValues({ last_error: msg })
			this.log('error', msg)
			return
		}
		try {
			const data = await this.callCompanion({
				op: 'transport',
				docId,
				action,
			})
			if (data.live) {
				this.docs = (this.docs || []).map((d) =>
					String(d.id) === String(data.live.id)
						? {
								...d,
								title: data.live.title || d.title,
								liveActive: !!data.live.liveActive,
								livePaused: !!data.live.livePaused,
								liveCurrentIdx: data.live.liveCurrentIdx,
							}
						: d,
				)
				this.lastChoiceSig = this.choiceSignature()
			}
			// A reply without `live` publishes nothing new; the live poll corrects it
			// rather than us re-asserting the pre-action cache.
			this.publishLiveState()
			this.setVariableValues({ last_action: action, last_error: '' })
			this.updateActions()
			this.updateStatus(InstanceStatus.Ok)
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e)
			this.setVariableValues({ last_error: msg })
			this.log('error', `${action}: ${msg}`)
		}
	}
}

runEntrypoint(SportsModuleRundownInstance, UpgradeScripts)
