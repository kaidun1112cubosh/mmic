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

            // HQ Pen diagnostics. These counters observe calls; they do not alter
            // pen quality, framebuffer allocation, or drawing arguments.
            this.penSkins = [];
            this.penWrappers = [];
            this.penMethodNames = [];
            this.penOperationCount = 0;
            this.penSilhouetteCount = 0;
            this.penSilhouetteTime = 0;
            this.measuredPenOperations = 0;
            this.measuredSilhouetteUpdates = 0;
            this.measuredSilhouetteTime = 0;
            this.penLastScan = 0;
            this.penDetails = 'Not scanned';

            this.sampleStartedAt = performance.now();
            this.sampleSteps = 0;
            this.sampleDraws = 0;
            this.measuredStepRate = 0;
            this.measuredRenderRate = 0;

            this.onStepEnd = () => {
                this.sampleSteps++;
            };
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
                name: 'MMIC V-Sync TEST v0.3 HQ Pen Diagnostics',
                color1: '#2878B8',
                color2: '#1F6399',
                color3: '#174D78',
                blocks: [
                    {
                        opcode: 'enableVSync',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'enable display-synchronized rendering'
                    },
                    {
                        opcode: 'disableVSync',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'disable display-synchronized rendering'
                    },
                    {
                        opcode: 'isEnabled',
                        blockType: Scratch.BlockType.BOOLEAN,
                        text: 'display-synchronized rendering enabled?'
                    },
                    {
                        opcode: 'getStepRate',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'measured VM steps per second'
                    },
                    {
                        opcode: 'getRenderRate',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'measured rendered frames per second'
                    },
                    {
                        opcode: 'getContextStatus',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'WebGL context status'
                    },
                    {
                        opcode: 'getLastContextEvent',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'last WebGL context event'
                    },
                    {
                        opcode: 'getResizeRedraws',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'immediate resize redraws'
                    },
                    {
                        opcode: 'getPenDetected',
                        blockType: Scratch.BlockType.BOOLEAN,
                        text: 'HQ Pen skin detected?'
                    },
                    {
                        opcode: 'getPenDetails',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'HQ Pen diagnostic details'
                    },
                    {
                        opcode: 'getPenOperations',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'HQ Pen operations per second'
                    },
                    {
                        opcode: 'getSilhouetteUpdates',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'pen silhouette updates per second'
                    },
                    {
                        opcode: 'getSilhouetteTime',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'pen silhouette time ms per second'
                    },
                    {
                        opcode: 'getPenMethods',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'instrumented HQ Pen methods'
                    },
                    {
                        opcode: 'getStatus',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'V-Sync status'
                    }
                ]
            };
        }

        _findPenSkins() {
            const renderer = this.runtime.renderer;
            const skins = renderer && renderer._allSkins;
            if (!skins || typeof skins[Symbol.iterator] !== 'function') return [];
            const found = [];
            for (const skin of skins) {
                if (!skin) continue;
                const className = skin.constructor && skin.constructor.name || '';
                if (/pen/i.test(className) || /pen/i.test(String(skin._id || ''))) {
                    found.push(skin);
                }
            }
            return found;
        }

        _describePenSkin(skin, index) {
            const props = [];
            const interesting = /width|height|size|scale|quality|frame|texture|buffer|silhouette|canvas|resolution/i;
            let keys = [];
            try { keys = Object.keys(skin); } catch (_) {}
            for (const key of keys) {
                if (!interesting.test(key)) continue;
                let value;
                try { value = skin[key]; } catch (_) { continue; }
                if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
                    props.push(`${key}=${String(value).slice(0, 80)}`);
                } else if (value && typeof value === 'object') {
                    const dims = [];
                    for (const dim of ['width', 'height', 'naturalWidth', 'naturalHeight']) {
                        try { if (Number.isFinite(value[dim])) dims.push(`${dim}:${value[dim]}`); } catch (_) {}
                    }
                    if (dims.length) props.push(`${key}{${dims.join(',')}}`);
                    else props.push(`${key}=[${value.constructor && value.constructor.name || 'object'}]`);
                }
            }
            return `skin${index} ${skin.constructor && skin.constructor.name || 'unknown'}: ${props.join(', ') || 'no public dimension-like properties found'}`;
        }

        _scanPenSkins(force = false) {
            const now = performance.now();
            if (!force && now - this.penLastScan < 1500) return;
            this.penLastScan = now;
            this.penSkins = this._findPenSkins();
            this.penDetails = this.penSkins.length
                ? this.penSkins.map((skin, i) => this._describePenSkin(skin, i)).join(' | ')
                : 'No PenSkin-like renderer skin found. Enable HQ Pen and draw something, then query again.';
            if (this.enabled) this._instrumentPenMethods();
        }

        _instrumentPenMethods() {
            const wanted = /(silhouette|stamp|drawline|penline|drawpoint|clearpen|pen.*draw|draw.*pen)/i;
            for (const skin of this.penSkins) {
                if (!skin || this.penWrappers.some(entry => entry.object === skin)) continue;
                let proto = skin;
                let depth = 0;
                while (proto && proto !== Object.prototype && depth++ < 4) {
                    let names = [];
                    try { names = Object.getOwnPropertyNames(proto); } catch (_) {}
                    for (const name of names) {
                        if (name === 'constructor' || !wanted.test(name)) continue;
                        let original;
                        try { original = skin[name]; } catch (_) { continue; }
                        if (typeof original !== 'function') continue;
                        // Avoid wrapping an inherited method more than once.
                        if (this.penWrappers.some(entry => entry.object === skin && entry.name === name)) continue;
                        const extension = this;
                        const wrapper = function (...args) {
                            const started = performance.now();
                            extension.penOperationCount++;
                            const silhouette = /silhouette/i.test(name);
                            if (silhouette) extension.penSilhouetteCount++;
                            try {
                                return original.apply(this, args);
                            } finally {
                                if (silhouette) extension.penSilhouetteTime += performance.now() - started;
                            }
                        };
                        try {
                            // Per-instance shadowing keeps other projects/instances untouched.
                            skin[name] = wrapper;
                            if (skin[name] === wrapper) {
                                this.penWrappers.push({ object: skin, name, original, wrapper, hadOwn: Object.prototype.hasOwnProperty.call(skin, name) });
                                if (!this.penMethodNames.includes(name)) this.penMethodNames.push(name);
                            }
                        } catch (_) {}
                    }
                    try { proto = Object.getPrototypeOf(proto); } catch (_) { break; }
                }
            }
        }

        _removePenInstrumentation() {
            for (const entry of this.penWrappers) {
                try {
                    if (entry.object[entry.name] === entry.wrapper) {
                        if (entry.hadOwn) entry.object[entry.name] = entry.original;
                        else delete entry.object[entry.name];
                    }
                } catch (_) {}
            }
            this.penWrappers = [];
            this.penMethodNames = [];
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

        _removeContextListeners() {
            if (this.canvas && this.onContextLost) {
                this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
            }
            if (this.canvas && this.onContextRestored) {
                this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
            }
            this.canvas = null;
            this.gl = null;
            this.onContextLost = null;
            this.onContextRestored = null;

            // HQ Pen diagnostics. These counters observe calls; they do not alter
            // pen quality, framebuffer allocation, or drawing arguments.
            this.penSkins = [];
            this.penWrappers = [];
            this.penMethodNames = [];
            this.penOperationCount = 0;
            this.penSilhouetteCount = 0;
            this.penSilhouetteTime = 0;
            this.measuredPenOperations = 0;
            this.measuredSilhouetteUpdates = 0;
            this.measuredSilhouetteTime = 0;
            this.penLastScan = 0;
            this.penDetails = 'Not scanned';
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
                // Diagnostic only: deliberately do not preventDefault() or attempt
                // to rebuild PenguinMod's internal WebGL resources.
                this.contextState = 'LOST';
                this.lastContextEvent = 'webglcontextlost';
                this.lastError = 'The browser reported that the WebGL context was lost.';
                console.error('[MMIC V-Sync Prototype]', this.lastError, event);
            };
            this.onContextRestored = () => {
                this.contextState = 'Restored event received (renderer resources may need rebuilding)';
                this.lastContextEvent = 'webglcontextrestored';
                console.warn('[MMIC V-Sync Prototype] WebGL context restored event received.');
            };
            this.canvas.addEventListener('webglcontextlost', this.onContextLost, false);
            this.canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);
            this._updateContextStatus();
        }

        _updateContextStatus() {
            if (!this.gl) {
                if (!this.contextState || this.contextState === 'Not checked') {
                    this.contextState = 'Unavailable';
                }
                return;
            }
            try {
                if (typeof this.gl.isContextLost === 'function' && this.gl.isContextLost()) {
                    this.contextState = 'LOST';
                } else if (this.contextState !== 'Restored event received (renderer resources may need rebuilding)') {
                    this.contextState = 'Available';
                }
            } catch (error) {
                this.contextState = 'Status check failed';
            }
        }

        _restoreRenderer() {
            this._removePenInstrumentation();
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
            // Setting canvas.width or canvas.height clears its drawing buffer.
            // PenguinMod normally redraws immediately after resize(). If we defer
            // this particular redraw to the next RAF, one blank canvas frame can
            // be displayed. Keep resize recovery synchronous; normal frames remain
            // RAF-synchronized.
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
                console.error('[MMIC V-Sync Prototype]', error);
                return undefined;
            }
        }

        _attachRenderer() {
            const renderer = this.runtime.renderer;
            if (!renderer || typeof renderer.draw !== 'function') {
                this.lastError = 'Renderer is not available yet.';
                return false;
            }

            if (renderer === this.renderer && renderer.draw === this.wrappedDraw) {
                return true;
            }

            this._restoreRenderer();
            this.renderer = renderer;
            this.originalDraw = renderer.draw;
            this._attachContextListeners(renderer);

            const extension = this;
            const original = this.originalDraw;
            this.wrappedDraw = function (...args) {
                if (!extension.enabled) {
                    return original.apply(this, args);
                }

                const canvas = extension._getCanvas(this);
                if (canvas) {
                    const resized = canvas.width !== extension.canvasWidth ||
                        canvas.height !== extension.canvasHeight;
                    if (resized) {
                        extension.canvasWidth = canvas.width;
                        extension.canvasHeight = canvas.height;
                        extension._updateContextStatus();
                        if (this.dirty !== false) {
                            return extension._drawImmediatelyAfterResize(this, original, args);
                        }
                    }
                }

                // RenderWebGL.draw() is a no-op when dirty is false. Avoid queuing
                // an animation frame when there is no changed scene to present.
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
            this._scanPenSkins(false);
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
                // Only draw if the scene is still dirty. The VM can have drawn or
                // cleared the dirty flag through another renderer path meanwhile.
                if (this.renderer.dirty === false) return;
                this.originalDraw.call(this.renderer);
                this.sampleDraws++;
                this.lastDrawTime = performance.now();
                this._updateContextStatus();
            } catch (error) {
                this.lastError = `Renderer error: ${error && error.message ? error.message : String(error)}`;
                console.error('[MMIC V-Sync Prototype]', error);
            }
        }

        enableVSync() {
            if (this.enabled) return;

            if (this.runtime.interpolationEnabled ||
                (this.runtime.frameLoop && this.runtime.frameLoop._interpolationAnimation)) {
                this.lastError = 'Turn off project interpolation before testing this prototype.';
                console.warn('[MMIC V-Sync Prototype]', this.lastError);
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
            this.penOperationCount = 0;
            this.penSilhouetteCount = 0;
            this.penSilhouetteTime = 0;
            this.measuredPenOperations = 0;
            this.measuredSilhouetteUpdates = 0;
            this.measuredSilhouetteTime = 0;
            this.penLastScan = 0;
            this.lastError = '';

            if (!this._attachRenderer()) {
                this.enabled = false;
                return;
            }
            this._scanPenSkins(true);

            // Request an initial frame only when the renderer already has a
            // pending dirty scene (do not force a needless full redraw).
            if (this.renderer && this.renderer.dirty) {
                this.needsDraw = true;
                this._scheduleDraw();
            }
        }

        disableVSync() {
            if (!this.enabled && !this.wrappedDraw) return;

            this.enabled = false;
            this._cancelPendingFrame();
            this._removePenInstrumentation();

            const renderer = this.renderer;
            const original = this.originalDraw;
            this._restoreRenderer();

            if (renderer && original) {
                try {
                    original.call(renderer);
                } catch (error) {
                    console.error('[MMIC V-Sync Prototype] Error restoring renderer:', error);
                }
            }
            this.needsDraw = false;
        }

        _updateRates() {
            const now = performance.now();
            const elapsed = now - this.sampleStartedAt;
            if (elapsed >= 1000) {
                this.measuredStepRate = this.sampleSteps * 1000 / elapsed;
                this.measuredRenderRate = this.sampleDraws * 1000 / elapsed;
                this.measuredPenOperations = this.penOperationCount * 1000 / elapsed;
                this.measuredSilhouetteUpdates = this.penSilhouetteCount * 1000 / elapsed;
                this.measuredSilhouetteTime = this.penSilhouetteTime * 1000 / elapsed;
                this.penOperationCount = 0;
                this.penSilhouetteCount = 0;
                this.penSilhouetteTime = 0;
                this.sampleSteps = 0;
                this.sampleDraws = 0;
                this.sampleStartedAt = now;
            }
        }

        isEnabled() {
            return this.enabled;
        }

        getStepRate() {
            this._updateRates();
            return Math.round(this.measuredStepRate * 10) / 10;
        }

        getRenderRate() {
            this._updateRates();
            return Math.round(this.measuredRenderRate * 10) / 10;
        }

        getContextStatus() {
            this._updateContextStatus();
            return this.contextState;
        }

        getLastContextEvent() {
            return this.lastContextEvent;
        }

        getResizeRedraws() {
            return this.resizeRedraws;
        }

        getPenDetected() {
            this._scanPenSkins(true);
            return this.penSkins.length > 0;
        }

        getPenDetails() {
            this._scanPenSkins(true);
            return this.penDetails;
        }

        getPenOperations() {
            this._updateRates();
            return Math.round(this.measuredPenOperations * 10) / 10;
        }

        getSilhouetteUpdates() {
            this._updateRates();
            return Math.round(this.measuredSilhouetteUpdates * 10) / 10;
        }

        getSilhouetteTime() {
            this._updateRates();
            return Math.round(this.measuredSilhouetteTime * 100) / 100;
        }

        getPenMethods() {
            return this.penMethodNames.join(', ') || 'No matching methods instrumented';
        }

        getStatus() {
            if (this.lastError) return this.lastError;
            return this.enabled ? 'Enabled' : 'Disabled';
        }
    }

    Scratch.extensions.register(new MMICVSyncPrototype());
})(Scratch);
