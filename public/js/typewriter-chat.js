// Typewriter chat utility. Plays a long string into one or more chat
// bubbles, splitting at sentence boundaries (.!?…) followed by whitespace
// with a short conversational pause between bubbles — feels like a chat
// partner sending a few quick messages instead of one wall of text.
//
// Stack-agnostic: you supply two callbacks. `onOpenBubble` returns the
// DOM node where text characters should be appended (typically the inner
// <p> of a freshly created bubble). `onChar` decides how each character
// is appended — the default wraps it in <span class="addspot-char-fade">
// so the CSS keyframe fades it in.
//
// Ported from mealplan's React ChatPanel typewriter:
// https://github.com/elehmanndev/mealplan/blob/main/src/components/chat/ChatPanel.tsx
(function () {
    const SENTENCE_END = /[.!?…]/;

    function defaultOnChar(bubbleEl, ch) {
        const span = document.createElement("span");
        span.className = "addspot-char-fade";
        span.textContent = ch;
        bubbleEl.appendChild(span);
    }

    function createTypewriter(opts) {
        const cfg = Object.assign({
            charsPerTick: 2,
            tickMs: 25,                     // → ~80 chars/sec within a bubble
            pauseBetweenBubblesMs: 600,     // beat between bubbles
            onOpenBubble: null,             // () => HTMLElement to append chars into
            onChar: defaultOnChar,          // (bubbleEl, char) => void
            onAfterAppend: null,            // (bubbleEl) => void (e.g. scroll)
            onDone: null,                   // () => void
        }, opts || {});

        if (typeof cfg.onOpenBubble !== "function") {
            throw new Error("typewriter-chat: onOpenBubble is required");
        }
        const pauseTicksTarget = Math.max(
            1,
            Math.round(cfg.pauseBetweenBubblesMs / cfg.tickMs),
        );

        function play(text) {
            // Iterate by code point so emojis / surrogate pairs don't get split.
            let buffer = Array.from(String(text || ""));
            let currentBubble = null;
            let pendingNewBubble = true;
            let pauseTicks = 0;
            let aborted = false;
            let timer = null;

            function finish() {
                if (timer != null) {
                    clearInterval(timer);
                    timer = null;
                }
                if (cfg.onDone) cfg.onDone();
            }

            timer = setInterval(() => {
                if (aborted) return;
                if (pauseTicks > 0) {
                    pauseTicks--;
                    return;
                }
                if (pendingNewBubble) {
                    currentBubble = cfg.onOpenBubble();
                    pendingNewBubble = false;
                    return;
                }
                if (buffer.length === 0) {
                    finish();
                    return;
                }

                // Scan the chunk window for a sentence boundary so we seal the
                // current bubble at a natural break instead of mid-clause.
                const win = Math.min(cfg.charsPerTick, buffer.length);
                let stopAt = win;
                let sealed = false;
                for (let i = 0; i < win; i++) {
                    const c = buffer[i];
                    const next = buffer[i + 1];
                    if (SENTENCE_END.test(c) && next && /\s/.test(next)) {
                        stopAt = i + 1;
                        sealed = true;
                        break;
                    }
                }
                const out = buffer.slice(0, stopAt);
                let remainder = buffer.slice(stopAt);
                if (sealed) {
                    // Eat the whitespace that would otherwise lead the next
                    // bubble. Loop because the model may have multiple
                    // consecutive whitespace chars (newlines, spaces).
                    while (remainder.length && /\s/.test(remainder[0])) {
                        remainder.shift();
                    }
                    pauseTicks = pauseTicksTarget;
                    pendingNewBubble = true;
                }
                buffer = remainder;
                for (const ch of out) cfg.onChar(currentBubble, ch);
                if (cfg.onAfterAppend) cfg.onAfterAppend(currentBubble);
            }, cfg.tickMs);

            return {
                abort() {
                    aborted = true;
                    finish();
                },
            };
        }

        return { play };
    }

    window.OpmTypewriter = { createTypewriter };
})();
