(function (Scratch) {
    'use strict';

    if (!Scratch.extensions.unsandboxed) {
        throw new Error('MMIC V-Sync Prototype must be loaded unsandboxed.');
    }

    const vm = Scratch.vm;
    if (!vm || !vm.runtime) {
        throw new Error('MMIC V-Sync Prototype could not access the PenguinMod VM.');
    }

    class MMICVSyncPrototype {
        constructor() {
            this.runtime = vm.runtime;
            this.enabled = false;
            this.renderer = null;
            this.originalDraw = null;
            this.wrappedDraw = null;
            this.pendingFrame = null;
            this.needsDraw = false;
            this.lastError = '';
            this.contextState = 'Not checked';
            this.lastContextEvent = 'None';
            this.resizeRedraws = 0;
            this.lastDrawTime = 0;
            this.canvasWidth = null;
            this.canvasHeight = null;
            this.canvas = null;
            this.gl = null;
            this.onContextLost = null;
            this.onContextRestored = null;

            // TurboWarp scratch-render HQ Pen diagnostics.
            // These inspect the renderer's documented/implemented HQ-render API
            // and its PenSkin. They do not change quality or drawing behavior.
            this.penSkin = null;
            this.penSkinId = null;
            this.penDetails = 'Not scanned';
            this.penMethodWrappers = [];
            this.rendererHook = null;
            this.originalCreatePenSkin = null;
            this.wrappedCreatePenSkin = null;
            this.originalSetHQ = null;
            this.wrappedSetHQ = null;
            this.diagnosticInterval = null;
            this.penStats = Object.create(null);
            this.lastHQState = 'Unknown';

            this.sampleStartedAt = performance.now();
            this.sampleSteps = 0;
            this.sampleDraws = 0;
            this.measuredStepRate = 0;
            this.measuredRenderRate = 0;

            this.onStepEnd = () => { this.sampleSteps++; };
            this.onVisibilityChange = () => {
                if (this.enabled && !document.hidden && this.renderer && this.renderer.dirty) {
                    this.needsDraw = true;
                    this._scheduleDraw();
                }
            };
            this.onRuntimeDisposed = () => this.disableVSync();

            this.runtime.on('RUNTIME_STEP_END', this.onStepEnd);
            this.runtime.on('RUNTIME_DISPOSED', this.onRuntimeDisposed);
            document.addEventListener('visibilitychange', this.onVisibilityChange);
        }

        getInfo() {
            return {
                id: 'mmicVsyncPrototype',
                name: 'MMIC V-Sync TEST v0.3.1 HQ Pen Diagnostics',
                color1: '#2878B8',
                color2: '#1F6399',
                color3: '#174D78',
                blocks: [
                    { opcode: 'enableVSync', blockType: Scratch.BlockType.COMMAND, text: 'enable display-synchronized rendering' },
                    { opcode: 'disableVSync', blockType: Scratch.BlockType.COMMAND, text: 'disable display-synchronized rendering' },
                    { opcode: 'isEnabled', blockType: Scratch.BlockType.BOOLEAN, text: 'display-synchronized rendering enabled?' },
                    { opcode: 'getStepRate', blockType: Scratch.BlockType.REPORTER, text: 'measured VM steps per second' },
                    { opcode: 'getRenderRate', blockType: Scratch.BlockType.REPORTER, text: 'measured rendered frames per second' },
                    { opcode: 'getContextStatus', blockType: Scratch.BlockType.REPORTER, text: 'WebGL context status' },
                    { opcode: 'getLastContextEvent', blockType: Scratch.BlockType.REPORTER, text: 'last WebGL context event' },
                    { opcode: 'getResizeRedraws', blockType: Scratch.BlockType.REPORTER, text: 'immediate resize redraws' },
                    { opcode: 'getHQEnabled', blockType: Scratch.BlockType.BOOLEAN, text: 'TurboWarp HQ render enabled?' },
                    { opcode: 'getPenSkinDetected', blockType: Scratch.BlockType.BOOLEAN, text: 'renderer PenSkin exists?' },
                    { opcode: 'getPenSkinId', blockType: Scratch.BlockType.REPORTER, text: 'renderer PenSkin ID' },
                    { opcode: 'getPenDetails', blockType: Scratch.BlockType.REPORTER, text: 'HQ Pen renderer details' },
                    { opcode: 'getPenMethodStats', blockType: Scratch.BlockType.REPORTER, text: 'HQ Pen method calls and timings' },
                    { opcode: 'getStatus', blockType: Scratch.BlockType.REPORTER, text: 'V-Sync status' }
                ]
            };
        }

        _getCanvas(renderer) {
            if (!renderer) return null;
            return renderer.canvas || (renderer.gl && renderer.gl.canvas) ||
                (renderer._gl && renderer._gl.canvas) || null;
        }

        _getGL(renderer) {
            if (!renderer) return null;
            return renderer.gl || renderer._gl || null;
        }

        _getPenSkin(renderer) {
            if (!renderer || !Number.isInteger(renderer._penSkinId) || renderer._penSkinId < 0) {
                return { id: null, skin: null };
            }
            const skin = renderer._allSkins && renderer._allSkins[renderer._penSkinId];
            return { id: renderer._penSkinId, skin: skin || null };
        }

        _describePenSkin() {
            const renderer = this.renderer || this.runtime.renderer;
            if (!renderer) return 'Renderer unavailable';
            const found = this._getPenSkin(renderer);
            const skin = found.skin;
            if (!skin) {
                return `No renderer PenSkin at _penSkinId=${String(renderer._penSkinId)}; HQ render=${String(renderer.useHighQualityRender)}`;
            }

            const size = Array.isArray(skin._size) ? skin._size.join('x') : 'unknown';
            const native = Array.isArray(skin._nativeSize) ? skin._nativeSize.join('x') : 'unknown';
            const quality = Number.isFinite(skin.renderQuality) ? skin.renderQuality : 'unknown';
            const fb = skin._framebuffer || null;
            const fbSize = fb && Number.isFinite(fb.width) && Number.isFinite(fb.height)
                ? `${fb.width}x${fb.height}` : 'not exposed';
            const texture = skin._texture ? 'present' : 'missing';
            const silhouetteDirty = Boolean(skin._silhouetteDirty);
            return `HQ render=${String(renderer.useHighQualityRender)}; PenSkin=${skin.constructor && skin.constructor.name || 'unknown'}; id=${found.id}; renderQuality=${quality}; penBuffer=${size}; nativeSize=${native}; framebufferInfo=${fbSize}; texture=${texture}; silhouetteDirty=${silhouetteDirty}`;
        }

        _scanAndInstrumentPenSkin(reason) {
            const renderer = this.renderer || this.runtime.renderer;
            if (!renderer) {
                this.penSkin = null;
                this.penSkinId = null;
                this.penDetails = 'Renderer unavailable';
                return;
            }

            const found = this._getPenSkin(renderer);
            if (found.skin !== this.penSkin) {
                this._removePenMethodInstrumentation();
                this.penSkin = found.skin;
                this.penSkinId = found.id;
                if (this.penSkin) {
                    this._instrumentPenSkin(this.penSkin);
                    console.info('[MMIC V-Sync v0.3.1] TurboWarp PenSkin detected.', {
                        id: this.penSkinId,
                        className: this.penSkin.constructor && this.penSkin.constructor.name,
                        methodsWrapped: this.penMethodWrappers.map(item => item.name)
                    });
                } else {
                    console.warn('[MMIC V-Sync v0.3.1] No PenSkin currently registered. HQ-render toggle is checked separately.');
                }
            }
            this.penDetails = this._describePenSkin();
            const hq = Boolean(renderer.useHighQualityRender);
            if (this.lastHQState !== String(hq)) {
                this.lastHQState = String(hq);
                console.info('[MMIC V-Sync v0.3.1] TurboWarp HQ-render state:', hq);
            }
        }

        _instrumentPenSkin(skin) {
            // Exact methods from TurboWarp scratch-render's PenSkin implementation.
            const methods = [
                'clear',
                'drawPoint',
                'drawLine',
                '_drawLineOnBuffer',
                '_flushLines',
                '_setCanvasSize',
                'setRenderQuality',
                'updateSilhouette'
            ];
            for (const name of methods) {
                const original = skin[name];
                if (typeof original !== 'function') continue;
                const hadOwn = Object.prototype.hasOwnProperty.call(skin, name);
                const ownDescriptor = hadOwn ? Object.getOwnPropertyDescriptor(skin, name) : null;
                const stats = this.penStats[name] = { calls: 0, totalMs: 0, maxMs: 0 };
                const extension = this;
                const wrapper = function (...args) {
                    const start = performance.now();
                    try {
                        return original.apply(this, args);
                    } finally {
                        const elapsed = performance.now() - start;
                        stats.calls++;
                        stats.totalMs += elapsed;
                        if (elapsed > stats.maxMs) stats.maxMs = elapsed;
                    }
                };
                try {
                    Object.defineProperty(skin, name, {
                        configurable: true,
                        enumerable: ownDescriptor ? ownDescriptor.enumerable : false,
                        writable: true,
                        value: wrapper
                    });
                    this.penMethodWrappers.push({ skin, name, original, wrapper, hadOwn, ownDescriptor });
                } catch (error) {
                    console.warn(`[MMIC V-Sync v0.3.1] Could not instrument PenSkin.${name}:`, error);
                }
            }
        }

        _removePenMethodInstrumentation() {
            for (const item of this.penMethodWrappers) {
                try {
                    if (item.skin[item.name] === item.wrapper) {
                        if (item.hadOwn) Object.defineProperty(item.skin, item.name, item.ownDescriptor);
                        else delete item.skin[item.name];
                    }
                } catch (error) {
                    console.warn('[MMIC V-Sync v0.3.1] Could not restore PenSkin method:', item.name, error);
                }
            }
            this.penMethodWrappers = [];
            this.penStats = Object.create(null);
        }

        _hookRendererMethods(renderer) {
            if (!renderer) return;
            if (typeof renderer.createPenSkin === 'function' && renderer.createPenSkin !== this.wrappedCreatePenSkin) {
                this.originalCreatePenSkin = renderer.createPenSkin;
                const extension = this;
                this.wrappedCreatePenSkin = function (...args) {
                    const id = extension.originalCreatePenSkin.apply(this, args);
                    extension._scanAndInstrumentPenSkin('createPenSkin');
                    console.info('[MMIC V-Sync v0.3.1] renderer.createPenSkin() called; returned skin ID:', id);
                    return id;
                };
                renderer.createPenSkin = this.wrappedCreatePenSkin;
                if (renderer.createPenSkin !== this.wrappedCreatePenSkin) {
                    this.wrappedCreatePenSkin = null;
                    this.originalCreatePenSkin = null;
                }
            }
            if (typeof renderer.setUseHighQualityRender === 'function' && renderer.setUseHighQualityRender !== this.wrappedSetHQ) {
                this.originalSetHQ = renderer.setUseHighQualityRender;
                const extension = this;
                this.wrappedSetHQ = function (enabled, ...args) {
                    console.info('[MMIC V-Sync v0.3.1] renderer.setUseHighQualityRender(', enabled, ')');
                    const result = extension.originalSetHQ.call(this, enabled, ...args);
                    extension._scanAndInstrumentPenSkin('setUseHighQualityRender');
                    return result;
                };
                renderer.setUseHighQualityRender = this.wrappedSetHQ;
                if (renderer.setUseHighQualityRender !== this.wrappedSetHQ) {
                    this.wrappedSetHQ = null;
                    this.originalSetHQ = null;
                }
            }
        }

        _restoreRendererHooks() {
            const renderer = this.renderer;
            if (!renderer) return;
            if (this.wrappedCreatePenSkin && renderer.createPenSkin === this.wrappedCreatePenSkin) {
                renderer.createPenSkin = this.originalCreatePenSkin;
            }
            if (this.wrappedSetHQ && renderer.setUseHighQualityRender === this.wrappedSetHQ) {
                renderer.setUseHighQualityRender = this.originalSetHQ;
            }
            this.originalCreatePenSkin = null;
            this.wrappedCreatePenSkin = null;
            this.originalSetHQ = null;
            this.wrappedSetHQ = null;
        }

        _logPenReport() {
            if (!this.enabled) return;
            this._scanAndInstrumentPenSkin('periodic');
            const stats = {};
            for (const [name, value] of Object.entries(this.penStats)) {
                stats[name] = {
                    calls: value.calls,
                    totalMs: Number(value.totalMs.toFixed(3)),
                    maxMs: Number(value.maxMs.toFixed(3))
                };
                value.calls = 0;
                value.totalMs = 0;
                value.maxMs = 0;
            }
            console.info('[MMIC V-Sync v0.3.1] HQ Pen diagnostic sample (last ~2 seconds)', {
                hqRenderEnabled: Boolean(this.renderer && this.renderer.useHighQualityRender),
                penSkinId: this.penSkinId,
                penSkinClass: this.penSkin && this.penSkin.constructor && this.penSkin.constructor.name,
                penDetails: this.penDetails,
                methods: stats
            });
        }

        _startDiagnostics() {
            this._scanAndInstrumentPenSkin('enable');
            this._hookRendererMethods(this.renderer);
            this._scanAndInstrumentPenSkin('after-hooks');
            if (this.diagnosticInterval !== null) clearInterval(this.diagnosticInterval);
            this.diagnosticInterval = setInterval(() => this._logPenReport(), 2000);
            console.info('[MMIC V-Sync v0.3.1] HQ Pen diagnostics started. Reports will appear every 2 seconds.');
        }

        _stopDiagnostics() {
            if (this.diagnosticInterval !== null) {
                clearInterval(this.diagnosticInterval);
                this.diagnosticInterval = null;
            }
            this._removePenMethodInstrumentation();
            this._restoreRendererHooks();
            this.penSkin = null;
            this.penSkinId = null;
        }

        _removeContextListeners() {
            if (this.canvas && this.onContextLost) this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
            if (this.canvas && this.onContextRestored) this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
            this.canvas = null;
            this.gl = null;
            this.onContextLost = null;
            this.onContextRestored = null;
        }

        _attachContextListeners(renderer) {
            this._removeContextListeners();
            this.canvas = this._getCanvas(renderer);
            this.gl = this._getGL(renderer);
            if (!this.canvas) {
                this.contextState = 'Canvas unavailable';
                return;
            }
            this.canvasWidth = this.canvas.width;
            this.canvasHeight = this.canvas.height;
            this.onContextLost = (event) => {
                this.contextState = 'LOST';
                this.lastContextEvent = 'webglcontextlost';
                this.lastError = 'The browser reported that the WebGL context was lost.';
                console.error('[MMIC V-Sync v0.3.1]', this.lastError, event);
            };
            this.onContextRestored = () => {
                this.contextState = 'Restored event received (renderer resources may need rebuilding)';
                this.lastContextEvent = 'webglcontextrestored';
                console.warn('[MMIC V-Sync v0.3.1] WebGL context restored event received.');
            };
            this.canvas.addEventListener('webglcontextlost', this.onContextLost, false);
            this.canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);
            this._updateContextStatus();
        }

        _updateContextStatus() {
            if (!this.gl) {
                if (!this.contextState || this.contextState === 'Not checked') this.contextState = 'Unavailable';
                return;
            }
            try {
                if (typeof this.gl.isContextLost === 'function' && this.gl.isContextLost()) this.contextState = 'LOST';
                else if (this.contextState !== 'Restored event received (renderer resources may need rebuilding)') this.contextState = 'Available';
            } catch (_) {
                this.contextState = 'Status check failed';
            }
        }

        _restoreRenderer() {
            this._stopDiagnostics();
            if (this.renderer && this.originalDraw && this.renderer.draw === this.wrappedDraw) {
                this.renderer.draw = this.originalDraw;
            }
            this._removeContextListeners();
            this.renderer = null;
            this.originalDraw = null;
            this.wrappedDraw = null;
            this.canvasWidth = null;
            this.canvasHeight = null;
        }

        _cancelPendingFrame() {
            if (this.pendingFrame !== null) {
                cancelAnimationFrame(this.pendingFrame);
                this.pendingFrame = null;
            }
        }

        _drawImmediatelyAfterResize(renderer, original, args) {
            this._cancelPendingFrame();
            this.needsDraw = false;
            try {
                const result = original.apply(renderer, args);
                this.sampleDraws++;
                this.resizeRedraws++;
                this.lastDrawTime = performance.now();
                this._updateContextStatus();
                return result;
            } catch (error) {
                this.lastError = `Resize redraw error: ${error && error.message ? error.message : String(error)}`;
                console.error('[MMIC V-Sync v0.3.1]', error);
                return undefined;
            }
        }

        _attachRenderer() {
            const renderer = this.runtime.renderer;
            if (!renderer || typeof renderer.draw !== 'function') {
                this.lastError = 'Renderer is not available yet.';
                return false;
            }
            if (renderer === this.renderer && renderer.draw === this.wrappedDraw) return true;

            this._restoreRenderer();
            this.renderer = renderer;
            this.originalDraw = renderer.draw;
            this._attachContextListeners(renderer);

            const extension = this;
            const original = this.originalDraw;
            this.wrappedDraw = function (...args) {
                if (!extension.enabled) return original.apply(this, args);
                const canvas = extension._getCanvas(this);
                if (canvas) {
                    const resized = canvas.width !== extension.canvasWidth || canvas.height !== extension.canvasHeight;
                    if (resized) {
                        extension.canvasWidth = canvas.width;
                        extension.canvasHeight = canvas.height;
                        extension._updateContextStatus();
                        if (this.dirty !== false) return extension._drawImmediatelyAfterResize(this, original, args);
                    }
                }
                if (this.dirty === false) return undefined;
                extension.needsDraw = true;
                extension._scheduleDraw();
                return undefined;
            };
            renderer.draw = this.wrappedDraw;
            if (renderer.draw !== this.wrappedDraw) {
                this.lastError = 'Could not attach to renderer.draw.';
                this._restoreRenderer();
                return false;
            }
            this.lastError = '';
            return true;
        }

        _scheduleDraw() {
            if (!this.enabled || this.pendingFrame !== null || document.hidden) return;
            this.pendingFrame = requestAnimationFrame(() => this._drawFrame());
        }

        _drawFrame() {
            this.pendingFrame = null;
            if (!this.enabled) return;
            if (!this.needsDraw) return;
            if (!this._attachRenderer()) return;
            if (document.hidden) return;
            const gl = this._getGL(this.renderer);
            if (gl && typeof gl.isContextLost === 'function' && gl.isContextLost()) {
                this.contextState = 'LOST';
                this.lastError = 'Draw skipped because the WebGL context is lost.';
                return;
            }
            this.needsDraw = false;
            try {
                if (this.renderer.dirty === false) return;
                this.originalDraw.call(this.renderer);
                this.sampleDraws++;
                this.lastDrawTime = performance.now();
                this._updateContextStatus();
            } catch (error) {
                this.lastError = `Renderer error: ${error && error.message ? error.message : String(error)}`;
                console.error('[MMIC V-Sync v0.3.1]', error);
            }
        }

        enableVSync() {
            if (this.enabled) return;
            if (this.runtime.interpolationEnabled ||
                (this.runtime.frameLoop && this.runtime.frameLoop._interpolationAnimation)) {
                this.lastError = 'Turn off project interpolation before testing this prototype.';
                console.warn('[MMIC V-Sync v0.3.1]', this.lastError);
                return;
            }
            this.enabled = true;
            this.needsDraw = false;
            this.sampleStartedAt = performance.now();
            this.sampleSteps = 0;
            this.sampleDraws = 0;
            this.measuredStepRate = 0;
            this.measuredRenderRate = 0;
            this.resizeRedraws = 0;
            this.lastError = '';

            if (!this._attachRenderer()) {
                this.enabled = false;
                return;
            }
            this._startDiagnostics();
            if (this.renderer && this.renderer.dirty) {
                this.needsDraw = true;
                this._scheduleDraw();
            }
        }

        disableVSync() {
            if (!this.enabled && !this.wrappedDraw) return;
            this.enabled = false;
            this._cancelPendingFrame();
            const renderer = this.renderer;
            const original = this.originalDraw;
            this._restoreRenderer();
            if (renderer && original) {
                try { original.call(renderer); }
                catch (error) { console.error('[MMIC V-Sync v0.3.1] Error restoring renderer:', error); }
            }
            this.needsDraw = false;
        }

        _updateRates() {
            const now = performance.now();
            const elapsed = now - this.sampleStartedAt;
            if (elapsed >= 1000) {
                this.measuredStepRate = this.sampleSteps * 1000 / elapsed;
                this.measuredRenderRate = this.sampleDraws * 1000 / elapsed;
                this.sampleSteps = 0;
                this.sampleDraws = 0;
                this.sampleStartedAt = now;
            }
        }

        isEnabled() { return this.enabled; }
        getStepRate() { this._updateRates(); return Math.round(this.measuredStepRate * 10) / 10; }
        getRenderRate() { this._updateRates(); return Math.round(this.measuredRenderRate * 10) / 10; }
        getContextStatus() { this._updateContextStatus(); return this.contextState; }
        getLastContextEvent() { return this.lastContextEvent; }
        getResizeRedraws() { return this.resizeRedraws; }
        getHQEnabled() { return Boolean(this.renderer && this.renderer.useHighQualityRender); }
        getPenSkinDetected() { return Boolean(this.renderer && this._getPenSkin(this.renderer).skin); }
        getPenSkinId() { return this.penSkinId === null ? 'No PenSkin' : this.penSkinId; }
        getPenDetails() { this._scanAndInstrumentPenSkin('reporter'); return this.penDetails; }
        getPenMethodStats() {
            const result = [];
            for (const [name, value] of Object.entries(this.penStats)) {
                result.push(`${name}: ${value.calls} calls, ${value.totalMs.toFixed(3)} ms total, ${value.maxMs.toFixed(3)} ms max`);
            }
            return result.join(' | ') || 'No PenSkin methods instrumented';
        }
        getStatus() {
            if (this.lastError) return this.lastError;
            return this.enabled ? 'Enabled' : 'Disabled';
        }
    }

    Scratch.extensions.register(new MMICVSyncPrototype());
})(Scratch);
