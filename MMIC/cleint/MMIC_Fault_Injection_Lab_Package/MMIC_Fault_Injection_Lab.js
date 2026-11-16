(function (Scratch) {
    'use strict';

    // MMIC Fault Injection Lab — development-only companion to MENGINE.
    // This extension is intentionally separate from MMIC V-Sync.
    // It does not modify IndexedDB, project saves, Launcher flags, or MediaCentre data.

    if (!Scratch || !Scratch.extensions || !Scratch.extensions.unsandboxed) {
        throw new Error('MMIC Fault Injection Lab must be loaded as an unsandboxed JavaScript V2 extension.');
    }

    const vm = Scratch.vm;
    if (!vm || !vm.runtime) {
        throw new Error('MMIC Fault Injection Lab could not access the PenguinMod VM.');
    }

    const ARM_TOKEN = 'MMIC-FAULT-TEST';
    const HISTORY_LIMIT = 16;

    const LEVEL_NAMES = [
        'NONE',
        'MINOR_IGNORED',
        'NORMAL_ERROR',
        'POTENTIALLY_SERIOUS',
        'SERIOUS_ERROR',
        'COMPONENT_FAILURE',
        'CRITICAL_FAULT',
        'CRITICAL_SYSTEM_FAULT',
        'CRITICAL_PAGE_FAULT'
    ];

    const LEVEL_DEFAULTS = {
        2: {
            code: 'TEST_NORMAL_ERROR',
            message: 'Injected test: normal error. MENGINE should write a debug-console entry.' ,
            scenario: 'NORMAL_ERROR',
            expectedAction: 'Debug console only; no restart.'
        },
        3: {
            code: 'TEST_POTENTIALLY_SERIOUS',
            message: 'Injected test: potentially serious error. MENGINE should alert the user.',
            scenario: 'POTENTIALLY_SERIOUS',
            expectedAction: 'Warning/alert; no restart.'
        },
        4: {
            code: 'TEST_SERIOUS_ERROR',
            message: 'Injected test: serious error. MENGINE should display its serious-error alert.',
            scenario: 'SERIOUS_ERROR',
            expectedAction: 'Serious-error alert; no restart unless MENGINE policy specifies otherwise.'
        },
        5: {
            code: 'TEST_COMPONENT_FAILURE',
            message: 'Injected test: component failure. MENGINE should execute its component-failure procedure.',
            scenario: 'COMPONENT_FAILURE',
            expectedAction: 'Component recovery/restart and user alert.'
        },
        6: {
            code: 'TEST_CRITICAL_FAULT',
            message: 'Injected test: critical fault. MENGINE should log, safely save, generate its dump, and use the Launcher recovery path.',
            scenario: 'CRITICAL_FAULT',
            expectedAction: 'Critical-fault safe-save and controlled restart/Launcher return.'
        },
        7: {
            code: 'TEST_CRITICAL_SYSTEM_FAULT',
            message: 'Injected test: critical system fault. MENGINE/Launcher should lock IndexedDB modifications, terminate processes, alert, and return to Launcher.',
            scenario: 'CRITICAL_SYSTEM_FAULT',
            expectedAction: 'Launcher storage lockdown, process termination, alert, and return to Launcher.'
        },
        8: {
            code: 'TEST_CRITICAL_PAGE_FAULT',
            message: 'Injected test: critical page fault. MENGINE should stop MMIC and tell the user to return to Launcher and refresh.',
            scenario: 'CRITICAL_PAGE_FAULT',
            expectedAction: 'erroroff / page shutdown handoff; user must return to Launcher and refresh.'
        }
    };

    const SCENARIOS = {
        normal_warning: {
            level: 2,
            code: 'TEST_NORMAL_ERROR',
            message: 'Injected recoverable error for MENGINE level 2 testing.',
            scenario: 'RECOVERABLE_ERROR',
            expectedAction: 'Debug console only.'
        },
        performance_degradation: {
            level: 3,
            code: 'TEST_PERFORMANCE_DEGRADATION',
            message: 'Injected performance degradation for MENGINE level 3 testing.',
            scenario: 'PERFORMANCE_DEGRADATION',
            expectedAction: 'Potentially-serious alert; no restart.'
        },
        scheduling_stall: {
            level: 3,
            code: 'TEST_RENDER_SCHEDULING_STALL',
            message: 'Injected rendering scheduling stall signal for MENGINE level 3 testing. No actual thread is blocked.',
            scenario: 'RENDER_SCHEDULING_STALL',
            expectedAction: 'Potentially-serious alert; no restart.'
        },
        serious_error: {
            level: 4,
            code: 'TEST_SERIOUS_ERROR',
            message: 'Injected serious-error signal for MENGINE level 4 testing.',
            scenario: 'SERIOUS_ERROR',
            expectedAction: 'Serious-error alert.'
        },
        component_state_invalid: {
            level: 4,
            code: 'TEST_COMPONENT_STATE_INVALID',
            message: 'Injected invalid-component-state signal for MENGINE level 4 testing.',
            scenario: 'COMPONENT_STATE_INVALID',
            expectedAction: 'Serious-error alert.'
        },
        component_unresponsive: {
            level: 5,
            code: 'TEST_COMPONENT_UNRESPONSIVE',
            message: 'Injected component-unresponsive signal for MENGINE level 5 testing. The extension itself remains responsive.',
            scenario: 'COMPONENT_UNRESPONSIVE',
            expectedAction: 'Component-failure procedure, recovery/restart, and user alert.'
        },
        renderer_exception: {
            level: 5,
            code: 'TEST_RENDERER_EXCEPTION_SIGNAL',
            message: 'Injected renderer-exception signal for MENGINE level 5 testing. This does not throw inside the real renderer.',
            scenario: 'RENDERER_EXCEPTION_SIGNAL',
            expectedAction: 'Component-failure procedure and user alert.'
        },
        scheduler_failure: {
            level: 5,
            code: 'TEST_RAF_SCHEDULER_FAILURE',
            message: 'Injected RAF-scheduler-failure signal for MENGINE level 5 testing. The browser scheduler is not actually replaced.',
            scenario: 'RAF_SCHEDULER_FAILURE',
            expectedAction: 'Component-failure procedure and user alert.'
        },
        critical_graphics: {
            level: 6,
            code: 'TEST_CRITICAL_GRAPHICS_FAULT',
            message: 'Injected critical graphics fault signal for MENGINE level 6 testing. This is synthetic; use the separate real WebGL loss command to test V-Sync context-loss detection.',
            scenario: 'CRITICAL_GRAPHICS_FAULT',
            expectedAction: 'Critical-fault safe-save, crash dump, and controlled Launcher recovery.'
        },
        critical_system: {
            level: 7,
            code: 'TEST_CRITICAL_SYSTEM_FAULT',
            message: 'Injected critical system/storage fault signal for MENGINE level 7 testing. The injector does not touch IndexedDB.',
            scenario: 'CRITICAL_SYSTEM_FAULT',
            expectedAction: 'Launcher IndexedDB modification lock, process termination, alert, and return to Launcher.'
        },
        critical_page: {
            level: 8,
            code: 'TEST_CRITICAL_PAGE_FAULT',
            message: 'Injected critical page shutdown signal for MENGINE level 8 testing. The injector does not kill or freeze the JavaScript thread.',
            scenario: 'CRITICAL_PAGE_FAULT',
            expectedAction: 'erroroff / shutdown handoff, with instructions to return to Launcher and refresh.'
        }
    };

    class MMICFaultInjectionLab {
        constructor() {
            this.runtime = vm.runtime;
            this.armed = false;
            this.sequence = 0;
            this.acknowledgedSequence = 0;
            this.history = [];
            this.lastEvent = null;
            this.lastAction = 'Idle. Injector is disarmed.';
            this.lastWebGLLossExtension = null;
            this.lastWebGLContext = null;
        }

        getInfo() {
            return {
                id: 'mmicfaultinjectionlab',
                name: 'MMIC Fault Injection Lab',
                color1: '#B84B35',
                color2: '#963B2A',
                color3: '#742D21',
                blocks: [
                    {
                        opcode: 'armInjector',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'arm fault injector with key [KEY]',
                        arguments: {
                            KEY: { type: Scratch.ArgumentType.STRING, defaultValue: '' }
                        }
                    },
                    { opcode: 'disarmInjector', blockType: Scratch.BlockType.COMMAND, text: 'disarm fault injector' },
                    {
                        opcode: 'injectLevel',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'inject MENGINE fault level [LEVEL] once',
                        arguments: {
                            LEVEL: { type: Scratch.ArgumentType.NUMBER, defaultValue: 5 }
                        }
                    },
                    {
                        opcode: 'injectScenario',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'inject fault scenario [SCENARIO] once',
                        arguments: {
                            SCENARIO: { type: Scratch.ArgumentType.STRING, menu: 'scenarioMenu' }
                        }
                    },
                    { opcode: 'loseActualWebGLContext', blockType: Scratch.BlockType.COMMAND, text: 'TEST ONLY: lose actual WebGL context' },
                    { opcode: 'restoreActualWebGLContext', blockType: Scratch.BlockType.COMMAND, text: 'TEST ONLY: request WebGL context restoration' },
                    {
                        opcode: 'acknowledgeThrough',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'acknowledge injected faults through sequence [SEQUENCE]',
                        arguments: {
                            SEQUENCE: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0 }
                        }
                    },
                    { opcode: 'acknowledgeCurrent', blockType: Scratch.BlockType.COMMAND, text: 'acknowledge current injected fault' },
                    { opcode: 'clearTestHistory', blockType: Scratch.BlockType.COMMAND, text: 'clear injected fault history' },
                    { opcode: 'isArmed', blockType: Scratch.BlockType.BOOLEAN, text: 'fault injector armed?' },
                    { opcode: 'hasPendingFault', blockType: Scratch.BlockType.BOOLEAN, text: 'injected MENGINE fault pending?' },
                    { opcode: 'getFaultLevel', blockType: Scratch.BlockType.REPORTER, text: 'injected fault severity level' },
                    { opcode: 'getFaultLevelName', blockType: Scratch.BlockType.REPORTER, text: 'injected fault severity name' },
                    { opcode: 'getFaultCode', blockType: Scratch.BlockType.REPORTER, text: 'injected fault code' },
                    { opcode: 'getFaultMessage', blockType: Scratch.BlockType.REPORTER, text: 'injected fault message' },
                    { opcode: 'getFaultSequence', blockType: Scratch.BlockType.REPORTER, text: 'injected fault sequence number' },
                    { opcode: 'getFaultCount', blockType: Scratch.BlockType.REPORTER, text: 'unacknowledged injected fault count' },
                    { opcode: 'getFaultJSON', blockType: Scratch.BlockType.REPORTER, text: 'injected fault details JSON' },
                    { opcode: 'getHistoryJSON', blockType: Scratch.BlockType.REPORTER, text: 'injected fault history JSON' },
                    { opcode: 'getInjectorStatus', blockType: Scratch.BlockType.REPORTER, text: 'fault injector status' },
                    { opcode: 'isRealWebGLLossAvailable', blockType: Scratch.BlockType.BOOLEAN, text: 'actual WebGL context-loss test available?' },
                    { opcode: 'isActualWebGLLost', blockType: Scratch.BlockType.BOOLEAN, text: 'actual WebGL context currently lost?' }
                ],
                menus: {
                    scenarioMenu: {
                        acceptReporters: false,
                        items: [
                            { text: 'Level 2 - normal error', value: 'normal_warning' },
                            { text: 'Level 3 - performance degradation', value: 'performance_degradation' },
                            { text: 'Level 3 - rendering scheduling stall', value: 'scheduling_stall' },
                            { text: 'Level 4 - serious error', value: 'serious_error' },
                            { text: 'Level 4 - invalid component state', value: 'component_state_invalid' },
                            { text: 'Level 5 - component unresponsive', value: 'component_unresponsive' },
                            { text: 'Level 5 - renderer exception signal', value: 'renderer_exception' },
                            { text: 'Level 5 - RAF scheduler failure signal', value: 'scheduler_failure' },
                            { text: 'Level 6 - critical graphics fault', value: 'critical_graphics' },
                            { text: 'Level 7 - critical system/storage fault', value: 'critical_system' },
                            { text: 'Level 8 - critical page shutdown', value: 'critical_page' }
                        ]
                    }
                }
            };
        }

        armInjector(args) {
            const key = String(args && args.KEY !== undefined ? args.KEY : '');
            if (key !== ARM_TOKEN) {
                this.armed = false;
                this.lastAction = 'ARM FAILED: authorization key did not match.';
                return;
            }
            this.armed = true;
            this.lastAction = 'ARMED. Test injection is enabled for this client session.';
        }

        disarmInjector() {
            this.armed = false;
            this.lastAction = 'DISARMED. Existing pending test records were preserved.';
        }

        _hasPending() {
            return this.sequence > this.acknowledgedSequence;
        }

        _pendingEvent() {
            if (!this._hasPending()) return null;
            for (let i = this.history.length - 1; i >= 0; i--) {
                if (this.history[i].sequence > this.acknowledgedSequence) return this.history[i];
            }
            return this.lastEvent;
        }

        _queueEvent(level, definition, origin) {
            if (!this.armed) {
                this.lastAction = 'REJECTED: arm the injector first.';
                return false;
            }
            if (this._hasPending()) {
                this.lastAction = 'REJECTED: an injected fault is still pending. Process and acknowledge it before injecting another.';
                return false;
            }
            const numericLevel = Math.trunc(Number(level));
            if (!Number.isFinite(numericLevel) || numericLevel < 2 || numericLevel > 8) {
                this.lastAction = 'REJECTED: supported test levels are 2 through 8.';
                return false;
            }
            const base = definition || LEVEL_DEFAULTS[numericLevel];
            if (!base) {
                this.lastAction = 'REJECTED: no definition exists for that test level.';
                return false;
            }

            const event = {
                sequence: ++this.sequence,
                level: numericLevel,
                severityName: LEVEL_NAMES[numericLevel],
                code: String(base.code || `TEST_LEVEL_${numericLevel}`),
                message: String(base.message || `Injected MENGINE level ${numericLevel} test fault.`),
                timestampMs: Number(performance.now().toFixed(2)),
                timestamp: new Date().toISOString(),
                source: 'MMIC_FAULT_INJECTION_LAB',
                scenario: String(base.scenario || LEVEL_NAMES[numericLevel]),
                synthetic: true,
                testOnly: true,
                origin: String(origin || 'synthetic'),
                details: {
                    expectedAction: String(base.expectedAction || 'Route through the existing MENGINE severity policy.'),
                    persistentStorageModified: false,
                    launcherFlagsModified: false,
                    realRendererDamaged: false,
                    note: 'This is a test signal. MENGINE/Launcher performs the actual configured response.'
                }
            };

            this.lastEvent = event;
            this.history.push(event);
            if (this.history.length > HISTORY_LIMIT) this.history.shift();
            this.lastAction = `QUEUED ${event.code} at level ${event.level}, sequence ${event.sequence}. MENGINE must poll the injector reporters.`;
            return true;
        }

        injectLevel(args) {
            const level = Math.trunc(Number(args && args.LEVEL));
            const definition = LEVEL_DEFAULTS[level];
            this._queueEvent(level, definition, 'level-selector');
        }

        injectScenario(args) {
            const name = String(args && args.SCENARIO || '');
            const definition = SCENARIOS[name];
            if (!definition) {
                this.lastAction = `REJECTED: unknown scenario '${name}'.`;
                return;
            }
            this._queueEvent(definition.level, definition, name);
        }

        _getRendererGL() {
            const renderer = this.runtime && this.runtime.renderer;
            if (!renderer) return null;
            return renderer.gl || renderer._gl || null;
        }

        _getWebGLLossExtension() {
            const gl = this._getRendererGL();
            if (!gl || typeof gl.getExtension !== 'function') return null;
            try {
                return gl.getExtension('WEBGL_lose_context');
            } catch (error) {
                this.lastAction = `WEBGL_lose_context lookup failed: ${error && error.message ? error.message : String(error)}`;
                return null;
            }
        }

        isRealWebGLLossAvailable() {
            return Boolean(this._getWebGLLossExtension());
        }

        isActualWebGLLost() {
            const gl = this.lastWebGLContext || this._getRendererGL();
            if (!gl || typeof gl.isContextLost !== 'function') return false;
            try { return Boolean(gl.isContextLost()); }
            catch (_) { return false; }
        }

        loseActualWebGLContext() {
            if (!this.armed) {
                this.lastAction = 'REJECTED: arm the injector first.';
                return;
            }
            const gl = this._getRendererGL();
            const extension = this._getWebGLLossExtension();
            if (!gl || !extension || typeof extension.loseContext !== 'function') {
                this.lastAction = 'FAILED: renderer WebGL context or WEBGL_lose_context extension is unavailable.';
                return;
            }
            if (typeof gl.isContextLost === 'function' && gl.isContextLost()) {
                this.lastAction = 'REJECTED: WebGL context is already lost.';
                return;
            }
            this.lastWebGLLossExtension = extension;
            this.lastWebGLContext = gl;
            try {
                extension.loseContext();
                this.lastAction = 'REAL WEBGL CONTEXT LOSS REQUESTED. V-Sync should receive webglcontextlost; MENGINE should process the real V-Sync fault. Renderer resources are invalidated.';
            } catch (error) {
                this.lastAction = `FAILED to lose WebGL context: ${error && error.message ? error.message : String(error)}`;
            }
        }

        restoreActualWebGLContext() {
            if (!this.armed) {
                this.lastAction = 'REJECTED: arm the injector first.';
                return;
            }
            let extension = this.lastWebGLLossExtension;
            if (!extension) extension = this._getWebGLLossExtension();
            if (!extension || typeof extension.restoreContext !== 'function') {
                this.lastAction = 'FAILED: WEBGL_lose_context.restoreContext() is unavailable.';
                return;
            }
            try {
                extension.restoreContext();
                this.lastAction = 'WebGL restoration requested. Wait for webglcontextrestored; this does not rebuild renderer resources or release the V-Sync failsafe.';
            } catch (error) {
                this.lastAction = `FAILED to request WebGL restoration: ${error && error.message ? error.message : String(error)}`;
            }
        }

        acknowledgeThrough(args) {
            const requested = Math.trunc(Number(args && args.SEQUENCE) || 0);
            this.acknowledgedSequence = Math.max(
                this.acknowledgedSequence,
                Math.min(this.sequence, Math.max(0, requested))
            );
            this.lastAction = `Acknowledged injected test faults through sequence ${this.acknowledgedSequence}.`;
        }

        acknowledgeCurrent() {
            this.acknowledgedSequence = this.sequence;
            this.lastAction = `Acknowledged all injected test faults through sequence ${this.acknowledgedSequence}.`;
        }

        clearTestHistory() {
            if (this._hasPending()) {
                this.lastAction = 'REJECTED: acknowledge the pending test fault before clearing test history.';
                return;
            }
            this.history = [];
            this.lastEvent = null;
            this.lastAction = 'Injected fault history cleared.';
        }

        isArmed() { return this.armed; }
        hasPendingFault() { return this._hasPending(); }
        getFaultLevel() { const event = this._pendingEvent(); return event ? event.level : 0; }
        getFaultLevelName() { const event = this._pendingEvent(); return event ? event.severityName : 'NONE'; }
        getFaultCode() { const event = this._pendingEvent() || this.lastEvent; return event ? event.code : 'NONE'; }
        getFaultMessage() { const event = this._pendingEvent() || this.lastEvent; return event ? event.message : 'No injected test fault.'; }
        getFaultSequence() { return this.sequence; }
        getFaultCount() { return this._hasPending() ? this.sequence - this.acknowledgedSequence : 0; }
        getFaultJSON() {
            const event = this._pendingEvent() || this.lastEvent;
            return event ? JSON.stringify(event) : '{}';
        }
        getHistoryJSON() { return JSON.stringify(this.history); }
        getInjectorStatus() { return this.lastAction; }
    }

    Scratch.extensions.register(new MMICFaultInjectionLab());
})(Scratch);
