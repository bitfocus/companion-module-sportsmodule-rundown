/**
 * Sports Module Rundown — Companion connection
 * Calls Edge Function rundown-companion (list + transport + cue poll).
 */
const { InstanceBase, runEntrypoint, InstanceStatus, combineRgb } = require('@companion-module/base')
const UpgradeScripts = require('./upgrades')
const Defaults = require('./defaults')

const CUE_POLL_MS = 500

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
		this.cuePollTimer = null
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
		this.stopCuePoll()
		this.accessToken = ''
		this.refreshToken = ''
		this.docs = []
	}

	async configUpdated(config, secrets) {
		this.config = config || {}
		this.secrets = secrets || {}
		this.cueAfterSeq = null
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
		this.stopCuePoll()
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
			await this.refreshDocList()
			this.updateActions()
			this.updateFeedbacks()
			this.updatePresets()
			this.setLiveVariables(null, '')
			this.setCueVariables()
			this.updateStatus(InstanceStatus.Ok)
			this.startCuePoll()
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
			{ variableId: 'rundown_title', name: 'Selected rundown title' },
			{ variableId: 'live_active', name: 'Selected rundown is live (true/false)' },
			{ variableId: 'live_paused', name: 'Selected rundown is paused (true/false)' },
			{ variableId: 'doc_id', name: 'Selected rundown id' },
			{ variableId: 'last_action', name: 'Last transport action' },
			{ variableId: 'last_error', name: 'Last error message' },
			{ variableId: 'last_cue_number', name: 'Last fired cue number (1-16)' },
			{ variableId: 'last_cue_name', name: 'Last fired cue name' },
			{ variableId: 'last_cue_event_id', name: 'Last fired line event id' },
			{ variableId: 'last_cue_line_text', name: 'Last fired line text' },
			{ variableId: 'last_cue_trigger_id', name: 'Last fired trigger id' },
			{ variableId: 'last_cue_at', name: 'Last fired cue time (ISO)' },
		])
	}

	setLiveVariables(live, action) {
		const docId = this.config && this.config.docId ? String(this.config.docId) : ''
		const fromList = (this.docs || []).find((d) => String(d.id) === docId)
		this.setVariableValues({
			rundown_title: (live && live.title) || (fromList && fromList.title) || '',
			live_active: live ? String(!!live.liveActive) : fromList ? String(!!fromList.liveActive) : 'false',
			live_paused: live ? String(!!live.livePaused) : fromList ? String(!!fromList.livePaused) : 'false',
			doc_id: (live && live.id) || docId,
			last_action: action || '',
			last_error: '',
		})
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

	async refreshDocList() {
		const data = await this.callCompanion({ op: 'list' })
		this.docs = Array.isArray(data.docs) ? data.docs : []
		this.log('info', `Loaded ${this.docs.length} rundown(s)`)
		this.updateActions()
	}

	selectedDocId() {
		return String((this.config && this.config.docId) || '').trim()
	}

	stopCuePoll() {
		if (this.cuePollTimer) {
			clearInterval(this.cuePollTimer)
			this.cuePollTimer = null
		}
		this.pollInFlight = false
	}

	startCuePoll() {
		this.stopCuePoll()
		const docId = this.selectedDocId()
		if (!docId) return
		this.cuePollTimer = setInterval(() => {
			this.pollCues().catch((e) => {
				const msg = e instanceof Error ? e.message : String(e)
				this.log('debug', `cue poll: ${msg}`)
			})
		}, CUE_POLL_MS)
		this.pollCues().catch(() => {})
	}

	async pollCues() {
		const docId = this.selectedDocId()
		if (!docId || this.pollInFlight) return
		this.pollInFlight = true
		try {
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
		} finally {
			this.pollInFlight = false
		}
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
		})
	}

	updatePresets() {
		const presets = {}
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
			}
			this.setLiveVariables(data.live || null, action)
			this.updateActions()
			this.updateStatus(InstanceStatus.Ok)
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e)
			this.setVariableValues({ last_error: msg, last_action: action })
			this.log('error', `${action}: ${msg}`)
		}
	}
}

runEntrypoint(SportsModuleRundownInstance, UpgradeScripts)
