// useIntegrityMonitor — detects and logs academic integrity events during
// a live quiz session.
//
// Three detectors run concurrently when `enabled` is true:
//   1. Tab switch   — document visibilitychange (tab/window hidden)
//   2. Window blur  — window blur (Alt+Tab or app switch even within same tab)
//   3. Fullscreen   — requests fullscreen when activated, logs + re-requests on exit
//   4. Paste        — page-level paste event
//
// Each detected event:
//   a. POSTs to /api/integrity-events (fire-and-forget, never blocks UI)
//   b. Shows a brief warning toast to the student
//
// All listeners are removed on unmount or when `enabled` flips to false.

import { useEffect, useRef, useCallback } from 'react'
import { API_URL } from '../config.js'

// ── Toast helper ──────────────────────────────────────────────────────────────
// Injects a self-removing toast into the DOM without needing a toast library.
function showWarningToast(message) {
  // Remove any existing integrity toast first (avoid stacking).
  document.getElementById('integrity-toast')?.remove()

  const toast = document.createElement('div')
  toast.id = 'integrity-toast'
  toast.setAttribute('role', 'alert')
  toast.style.cssText = `
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 99999;
    background: #ef4444;
    color: white;
    padding: 12px 20px;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 600;
    box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    max-width: 420px;
    text-align: center;
    animation: integritySlideDown 0.3s ease;
  `

  // Inject keyframes once.
  if (!document.getElementById('integrity-keyframes')) {
    const style = document.createElement('style')
    style.id = 'integrity-keyframes'
    style.textContent = `
      @keyframes integritySlideDown {
        from { opacity: 0; transform: translateX(-50%) translateY(-16px); }
        to   { opacity: 1; transform: translateX(-50%) translateY(0);     }
      }
    `
    document.head.appendChild(style)
  }

  toast.textContent = `⚠️ ${message}`
  document.body.appendChild(toast)
  setTimeout(() => toast.remove(), 4000)
}

// ── Main hook ─────────────────────────────────────────────────────────────────
export function useIntegrityMonitor({ roomId, questionId, token, enabled }) {
  // Keep a ref so the async POST closure always sees the latest questionId
  // without needing to re-register listeners on every question change.
  const questionIdRef = useRef(questionId)
  useEffect(() => { questionIdRef.current = questionId }, [questionId])

  // Track whether we currently hold fullscreen so we don't re-request
  // unnecessarily on every render.
  const fullscreenActiveRef = useRef(false)

  // ── POST helper ─────────────────────────────────────────────────────────────
  const logEvent = useCallback(async (eventType, metadata = {}) => {
    if (!roomId || !token) return
    try {
      await fetch(`${API_URL}/integrity-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          roomId,
          questionId: questionIdRef.current || null,
          eventType,
          metadata
        })
      })
    } catch {
      // Network errors are silently swallowed — integrity logging must never
      // crash or block the student's quiz experience.
    }
  }, [roomId, token])

  // ── Fullscreen helpers ───────────────────────────────────────────────────────
  const requestFullscreen = useCallback(() => {
    const el = document.documentElement
    if (!el.requestFullscreen) return   // API not available (some mobile browsers)
    if (document.fullscreenElement) return  // already fullscreen
    el.requestFullscreen().catch(() => {
      // requestFullscreen must be called from a user gesture; if it fails
      // (e.g. first call before any click), just skip silently.
    })
  }, [])

  // ── Effect: register / unregister all listeners ─────────────────────────────
  useEffect(() => {
    if (!enabled || !roomId || !token) return

    // 1. Request fullscreen immediately when a question goes active.
    requestFullscreen()
    fullscreenActiveRef.current = !!document.fullscreenElement

    // ── Handler: tab switch (visibilitychange) ─────────────────────────────
    function handleVisibility() {
      if (document.visibilityState === 'hidden') {
        logEvent('tab_switch', { visibilityState: 'hidden' })
        showWarningToast('You left the quiz tab — this has been recorded by your teacher.')
      }
    }

    // ── Handler: window blur (Alt+Tab / app switch) ────────────────────────
    // Fires when the browser window loses focus even when the tab stays active.
    // Debounced: blur often fires before visibilitychange on the same action,
    // so we only log a window_blur if no visibilitychange follows within 150ms.
    let blurDebounce = null
    function handleBlur() {
      blurDebounce = setTimeout(() => {
        // If the tab is already hidden, visibilitychange already covered it.
        if (document.visibilityState === 'visible') {
          logEvent('window_blur', {})
          showWarningToast('You left the quiz window — this has been recorded by your teacher.')
        }
      }, 150)
    }
    function handleFocus() {
      clearTimeout(blurDebounce)
    }

    // ── Handler: fullscreen exit ───────────────────────────────────────────
    function handleFullscreenChange() {
      const isNowFullscreen = !!document.fullscreenElement
      if (fullscreenActiveRef.current && !isNowFullscreen) {
        // Student exited fullscreen.
        logEvent('fullscreen_exit', {})
        showWarningToast('You exited fullscreen — this has been recorded. Returning to fullscreen...')
        // Re-request after a brief delay so the toast is visible first.
        setTimeout(requestFullscreen, 1200)
      }
      fullscreenActiveRef.current = isNowFullscreen
    }

    // ── Handler: paste ─────────────────────────────────────────────────────
    function handlePaste(e) {
      const pastedText   = e.clipboardData?.getData('text') || ''
      const pastedLength = pastedText.length
      logEvent('paste', { pastedLength })
      showWarningToast('Paste detected — this has been recorded by your teacher.')
    }

    // Register all listeners.
    document.addEventListener('visibilitychange',  handleVisibility)
    window.addEventListener('blur',                handleBlur)
    window.addEventListener('focus',               handleFocus)
    document.addEventListener('fullscreenchange',  handleFullscreenChange)
    document.addEventListener('paste',             handlePaste)

    return () => {
      // Clean up on unmount or when enabled becomes false (question ended).
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('blur',               handleBlur)
      window.removeEventListener('focus',              handleFocus)
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
      document.removeEventListener('paste',            handlePaste)
      clearTimeout(blurDebounce)

      // Exit fullscreen when the question ends so the teacher's page is
      // not stuck in fullscreen mode after the quiz.
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {})
      }
    }
  }, [enabled, roomId, token, logEvent, requestFullscreen])
}
