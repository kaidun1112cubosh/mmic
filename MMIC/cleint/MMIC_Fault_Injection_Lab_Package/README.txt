MMIC Fault Injection Lab
========================
Development-only extension for testing MENGINE and Launcher recovery.

IMPORTANT
---------
This is a separate extension from MMIC V-Sync. It does not replace V-Sync,
does not alter its renderer hooks, and does not directly call MENGINE or
Launcher internals. MENGINE must poll this extension's reporters as an
additional test-fault source.

The synthetic tests create an in-memory test event. They do NOT modify
IndexedDB, localStorage, project saves, MediaCentre caches, Launcher flags,
or running component state. MENGINE/Launcher must perform the real recovery
route after receiving the test event.

Do not include this extension in a production MMIC 1.0 client. Remove it or
ensure it is unavailable in production builds.

INSTALLATION
------------
1. Use a COPY of the stable packaged MMIC client with disposable data.
2. Load MMIC_Fault_Injection_Lab.js as an unsandboxed extension.
3. Add its test reporters to MENGINE's diagnostic polling, or add the small
   bridge described below.
4. Keep the ordinary V-Sync extension enabled for the real WebGL context-loss
'test. The synthetic scenarios do not require V-Sync to be enabled.
5. Never use the real WebGL-loss command against an MMIC profile containing
   irreplaceable data.

ARMING
------
The extension is disarmed by default. To arm it, use:

  arm fault injector with key [MMIC-FAULT-TEST]

This key is only an accidental-use interlock, NOT a security boundary.
Disarm after testing with `disarm fault injector`.

FAULT-INJECTION REPORTERS
-------------------------
- fault injector armed?
- injected MENGINE fault pending?
- injected fault severity level
- injected fault severity name
- injected fault code
- injected fault message
- injected fault sequence number
- unacknowledged injected fault count
- injected fault details JSON
- injected fault history JSON
- fault injector status

COMMANDS
--------
- arm fault injector with key [KEY]
- disarm fault injector
- inject MENGINE fault level [LEVEL] once (levels 2-8)
- inject fault scenario [SCENARIO] once
- acknowledge injected faults through sequence [SEQUENCE]
- acknowledge current injected fault
- clear injected fault history

SCENARIOS
---------
Level 2: normal error
  TEST_NORMAL_ERROR
  Expected: MENGINE debug-console entry; no restart.

Level 3: performance degradation
  TEST_PERFORMANCE_DEGRADATION
  Expected: potentially-serious warning/alert; no restart.

Level 3: rendering scheduling stall
  TEST_RENDER_SCHEDULING_STALL
  Expected: potentially-serious warning/alert. This is a synthetic signal; it
  does not block the JavaScript main thread or delay the real RAF queue.

Level 4: serious error
  TEST_SERIOUS_ERROR
  Expected: MENGINE serious-error alert.

Level 4: invalid component state
  TEST_COMPONENT_STATE_INVALID
  Expected: MENGINE serious-error alert.

Level 5: component unresponsive
  TEST_COMPONENT_UNRESPONSIVE
  Expected: component-failure path. The injector remains responsive; this is
  a synthetic health/fault signal, not a real frozen component.

Level 5: renderer exception signal
  TEST_RENDERER_EXCEPTION_SIGNAL
  Expected: component-failure path. This does not throw inside renderer.draw.

Level 5: RAF scheduler failure signal
  TEST_RAF_SCHEDULER_FAILURE
  Expected: component-failure path. The browser's real RAF scheduler is not
  replaced or disabled.

Level 6: critical graphics fault
  TEST_CRITICAL_GRAPHICS_FAULT
  Expected: MENGINE critical-fault safe-save, crash dump, controlled restart
  or Launcher return. This synthetic event does not lose the real GL context.

Level 7: critical system/storage fault
  TEST_CRITICAL_SYSTEM_FAULT
  Expected: MENGINE/Launcher IndexedDB modification lock, process termination,
  alert, and return to Launcher. The injector never writes to or corrupts DB.

Level 8: critical page shutdown
  TEST_CRITICAL_PAGE_FAULT
  Expected: MENGINE erroroff/shutdown path and a clear instruction to return to
  Launcher and refresh. The injector does not kill the JavaScript thread.

MENGINE BRIDGE
--------------
MENGINE should poll `injected MENGINE fault pending?` in its existing 10-frame
crash-detection cycle. When true, capture the event before acknowledgement:

  IF <injected MENGINE fault pending?> THEN
      SET TestFaultSequence TO (injected fault sequence number)
      SET TestFaultLevel TO (injected fault severity level)
      SET TestFaultName TO (injected fault severity name)
      SET TestFaultCode TO (injected fault code)
      SET TestFaultMessage TO (injected fault message)
      SET TestFaultJSON TO (injected fault details JSON)
      SET TestFaultHistory TO (injected fault history JSON)

      LOG the captured test fault and history
      ROUTE TestFaultLevel through the SAME MENGINE severity/recovery logic
      ACKNOWLEDGE injected faults through sequence (TestFaultSequence)
  END

For Levels 6-8, ensure MENGINE has captured/logged the event and generated any
required crash dump before invoking a restart/shutdown message that may end the
current script. If your restart broadcast runs synchronously, acknowledge after
logging/dump creation but immediately before sending that broadcast.

Do not merge the synthetic event history into the real V-Sync fault history.
Keep the source label `MMIC_FAULT_INJECTION_LAB` or the `TEST_` code prefix so
crash dumps clearly distinguish test signals from real faults.

ACTUAL WEBGL CONTEXT LOSS
-------------------------
Two additional commands test real WebGL context loss:

- TEST ONLY: lose actual WebGL context
- TEST ONLY: request WebGL context restoration

These use the renderer's existing WebGL context and its `WEBGL_lose_context`
extension. `loseContext()` causes a genuine WebGL context-loss event and
invalidates underlying graphics resources. This should be detected by the real
V-Sync event handler and its Level 6 fault reporter, not by the synthetic test
fault reporters.

Use only with a disposable packaged MMIC client and data. The Launcher may
restart/return to itself before a restoration command can be run. Do not
manually restore the context while MENGINE is already performing restart or
shutdown. A restored WebGL context does NOT mean PenguinMod renderer resources
have been rebuilt; do not release the V-Sync failsafe until MENGINE has
validated/rebuilt the renderer.

LIMITATIONS / WHAT IS NOT ACTUALLY INJECTED
------------------------------------------
- Levels 2-8 are synthetic MENGINE fault records. They test MENGINE's policy,
  alerts, dumps, Launcher handoff, and storage-lock response; they do not
  physically corrupt or disable each component.
- The real WebGL context-loss command is a genuine destructive browser graphics
  test.
- A real tab/browser process crash cannot be safely created and then handled
  by JavaScript running inside that same tab. Level 8 tests the application's
  shutdown/Launcher handoff while code is still running; it is not a browser
  process kill.
- The extension does not directly invoke `errorrestart`, `erroroff`, Launcher
  flags, IndexedDB locks, or process termination. Those remain MENGINE/Launcher
  responsibilities. MENGINE must poll the test reporters and use its existing
  recovery logic.

FAULT QUEUE BEHAVIOR
--------------------
Only one injected test fault may be pending at a time. This prevents accidental
re-triggering/repeated notifications. MENGINE must process and acknowledge the
current event before another one is injected. The history retains the latest
16 events. The sequence number increases monotonically for the extension
instance. Acknowledgement does not erase history.

VALIDATION
----------
The JavaScript should be syntax-checked and exercised with a mock runtime before
loading. Actual packaged PenguinMod/MMIC and Launcher behavior remains to be
verified by the user. The real WebGL loss command must be tested separately from
the synthetic Level 6 route.
