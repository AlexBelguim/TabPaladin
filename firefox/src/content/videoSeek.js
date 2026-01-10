/**
 * Video Seek Content Script
 * Enables scroll wheel to fast-forward/rewind fullscreen videos.
 * Scroll speed determines seek amount (absolute time, not percentage).
 */

(function () {
    'use strict';

    let lastScrollTime = 0;
    let scrollAccumulator = 0;
    const SCROLL_RESET_DELAY = 150; // ms to reset scroll speed detection

    /**
     * Get the fullscreen video element if one exists
     */
    function getFullscreenVideo() {
        const fsElement = document.fullscreenElement ||
            document.webkitFullscreenElement ||
            document.mozFullScreenElement;

        if (!fsElement) return null;

        // Check if the fullscreen element is a video
        if (fsElement.tagName === 'VIDEO') return fsElement;

        // Check for video inside the fullscreen element
        const video = fsElement.querySelector('video');
        if (video) return video;

        // For YouTube and similar players, check if any video is playing
        const videos = document.querySelectorAll('video');
        for (const v of videos) {
            if (!v.paused && v.readyState >= 2) return v;
        }

        return null;
    }

    /**
     * Calculate seek amount based on scroll delta
     * Slow scroll: 2-5 sec, Medium: 10-15 sec, Fast: 30 sec
     */
    function calculateSeekAmount(deltaY) {
        const absDelta = Math.abs(deltaY);

        // Determine base seek from scroll intensity
        let seekSeconds;
        if (absDelta < 50) {
            seekSeconds = 3; // Slow scroll
        } else if (absDelta < 150) {
            seekSeconds = 10; // Medium scroll
        } else {
            seekSeconds = 30; // Fast scroll
        }

        // Direction: scroll down = forward, scroll up = backward
        return deltaY > 0 ? seekSeconds : -seekSeconds;
    }

    /**
     * Handle wheel event on fullscreen video
     */
    function handleWheel(e) {
        const video = getFullscreenVideo();
        if (!video) return;

        // Prevent default scroll behavior
        e.preventDefault();
        e.stopPropagation();

        const now = Date.now();

        // Accumulate scroll for rapid scrolling detection
        if (now - lastScrollTime < SCROLL_RESET_DELAY) {
            scrollAccumulator += e.deltaY;
        } else {
            scrollAccumulator = e.deltaY;
        }
        lastScrollTime = now;

        // Calculate and apply seek
        const seekAmount = calculateSeekAmount(scrollAccumulator);
        const newTime = Math.max(0, Math.min(video.duration, video.currentTime + seekAmount));

        video.currentTime = newTime;

        // Reset accumulator after applying
        scrollAccumulator = 0;

        // Optional: Show visual feedback (works on some sites)
        showSeekFeedback(video, seekAmount);
    }

    /**
     * Show visual feedback for seek action
     */
    function showSeekFeedback(video, seekAmount) {
        // Remove existing feedback
        const existing = document.getElementById('tp-seek-feedback');
        if (existing) existing.remove();

        const feedback = document.createElement('div');
        feedback.id = 'tp-seek-feedback';
        feedback.textContent = `${seekAmount > 0 ? '+' : ''}${seekAmount}s`;
        feedback.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0, 0, 0, 0.7);
            color: white;
            padding: 20px 40px;
            border-radius: 10px;
            font-size: 32px;
            font-family: sans-serif;
            font-weight: bold;
            z-index: 2147483647;
            pointer-events: none;
            animation: tpFadeOut 0.8s ease-out forwards;
        `;

        // Add keyframes if not present
        if (!document.getElementById('tp-seek-styles')) {
            const style = document.createElement('style');
            style.id = 'tp-seek-styles';
            style.textContent = `
                @keyframes tpFadeOut {
                    0% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
                    100% { opacity: 0; transform: translate(-50%, -50%) scale(1.2); }
                }
            `;
            document.head.appendChild(style);
        }

        document.body.appendChild(feedback);
        setTimeout(() => feedback.remove(), 800);
    }

    // Listen for wheel events (capture phase to intercept early)
    document.addEventListener('wheel', handleWheel, { passive: false, capture: true });

    console.log('[TabPaladin] Video scroll seek enabled');
})();
