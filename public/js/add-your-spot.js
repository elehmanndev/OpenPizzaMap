// /add-your-spot — client controller for the Gemini intake chat.
//
// Conversation contract with the server:
//   POST /api/chat/add-spot      { history } → { reply, collected, complete }
//   POST /api/chat/finalize-spot { name, city, gmapsUrl, styleSlug }
//                                 → { redirect } | { queued, message } | { duplicate, redirect, message }
//
// UX: GPT-wrapper-style mobile-first chat. Textarea auto-grows up to ~5
// lines, Enter sends (Shift+Enter inserts a newline, matching ChatGPT
// and Claude mobile), Send button disables when empty/busy.
(function () {
    const root = document.querySelector("[data-addspot-chat]");
    if (!root) return;

    const log = root.querySelector("[data-addspot-log]");
    const typing = root.querySelector("[data-addspot-typing]");
    const form = document.querySelector("[data-addspot-form]");
    const input = document.querySelector("[data-addspot-input]");
    const sendBtn = document.querySelector("[data-addspot-send]");
    const errorBox = document.querySelector("[data-addspot-error]");

    const history = [];
    let collected = { name: null, city: null, gmapsUrl: null, styleSlug: null };
    let busy = false;
    let finalized = false;

    function autosizeInput() {
        if (!input) return;
        input.style.height = "auto";
        // Cap at ~5 lines (~140px) — CSS max-height handles overflow.
        input.style.height = Math.min(input.scrollHeight, 140) + "px";
    }

    function updateSendState() {
        if (!sendBtn || !input) return;
        const empty = !input.value.trim();
        sendBtn.disabled = busy || finalized || empty;
    }

    // Typing dots only appear while we're waiting on the model AFTER a
    // user turn. They stay hidden during the initial opener fetch (no
    // user message in flight) and the moment a bot reply lands.
    function setBusy(on, { showTyping = false } = {}) {
        busy = on;
        if (input) input.disabled = on;
        typing.hidden = !(on && showTyping);
        if (on && showTyping) scrollToBottom();
        updateSendState();
        if (!on && input && !finalized) input.focus();
    }

    function showError(msg) {
        errorBox.hidden = false;
        errorBox.textContent = msg;
    }
    function clearError() {
        errorBox.hidden = true;
        errorBox.textContent = "";
    }

    function scrollToBottom() {
        // rAF makes sure layout is settled before we scroll (otherwise
        // the new bubble hasn't been measured yet).
        requestAnimationFrame(() => { root.scrollTop = root.scrollHeight; });
    }

    function appendBubble(role, text) {
        const li = document.createElement("li");
        li.className = "addspot-bubble addspot-bubble--" + (role === "user" ? "user" : "bot");
        const p = document.createElement("p");
        p.textContent = text;
        li.appendChild(p);
        log.appendChild(li);
        scrollToBottom();
        return li;
    }

    // Open a fresh empty bot bubble and return its inner <p> for the
    // typewriter to append characters into.
    function openBotBubble() {
        const li = document.createElement("li");
        li.className = "addspot-bubble addspot-bubble--bot";
        const p = document.createElement("p");
        li.appendChild(p);
        log.appendChild(li);
        scrollToBottom();
        return p;
    }

    // Type out a bot reply into one or more bubbles, splitting at sentence
    // boundaries with a beat between bubbles (iMessage / WhatsApp feel).
    // Resolves once the entire reply has been typed and any final pause has
    // elapsed.
    function typeBotReply(text) {
        return new Promise((resolve) => {
            if (!text) {
                appendBubble("bot", "…");
                resolve();
                return;
            }
            // Hide the typing indicator the moment the first character lands.
            let typingHidden = false;
            const tw = window.OpmTypewriter.createTypewriter({
                onOpenBubble: openBotBubble,
                onChar: (bubbleEl, ch) => {
                    const span = document.createElement("span");
                    span.className = "addspot-char-fade";
                    span.textContent = ch;
                    bubbleEl.appendChild(span);
                    if (!typingHidden) {
                        typing.hidden = true;
                        typingHidden = true;
                    }
                },
                onAfterAppend: scrollToBottom,
                onDone: resolve,
            });
            tw.play(text);
        });
    }

    async function postJSON(url, body) {
        const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || data.ok === false) {
            const err = new Error(data.error || `Request failed (${resp.status})`);
            err.payload = data;
            throw err;
        }
        return data;
    }

    async function sendTurn(userText) {
        clearError();
        const isUserTurn = !!userText;
        if (isUserTurn) {
            history.push({ role: "user", text: userText });
            appendBubble("user", userText);
        }
        // Only show the typing indicator when there's a user message
        // in flight. The initial opener fetch is server-side canned —
        // dots before any conversation has happened just look like noise.
        setBusy(true, { showTyping: isUserTurn });
        try {
            const data = await postJSON("/api/chat/add-spot", { history });
            history.push({ role: "assistant", text: data.reply });
            collected = data.collected || collected;
            // Type the reply out across multiple bubbles instead of dropping
            // the whole wall of text at once. Wait for the typewriter to
            // drain before considering the turn complete — otherwise the
            // compose bar would re-enable mid-animation.
            await typeBotReply(data.reply || "…");
            if (data.complete) {
                finalized = true;
                await finalize();
            }
        } catch (err) {
            showError(err.message || "Something went wrong. Try again.");
        } finally {
            if (!finalized) setBusy(false);
        }
    }

    async function finalize() {
        // Only name + city are required. gmapsUrl is optional: the server
        // falls back to a Places Text Search by name+city when it's null.
        if (!collected.name || !collected.city) {
            finalized = false;
            showError("Looks like I missed a detail. Let's pick up where we left off.");
            setBusy(false);
            return;
        }

        appendBubble("bot", "Saving your spot…");
        try {
            const data = await postJSON("/api/chat/finalize-spot", {
                name: collected.name,
                city: collected.city,
                gmapsUrl: collected.gmapsUrl,
                styleSlug: collected.styleSlug || null,
            });

            if (data.redirect) {
                appendBubble("bot", data.message || "Redirecting to your spot so you can drop the first review…");
                setTimeout(() => { window.location.href = data.redirect; }, 900);
                return;
            }
            if (data.queued) {
                appendBubble("bot", data.message || "Thanks! Your spot is in the moderation queue.");
                if (form) form.hidden = true;
                return;
            }
            showError("Spot saved but no redirect was returned. Reload and check /me.");
        } catch (err) {
            showError(err.message || "Couldn't save your spot. Try again in a moment.");
            finalized = false;
            setBusy(false);
        }
    }

    // ── Compose UX ──────────────────────────────────────────────────────
    input.addEventListener("input", () => {
        autosizeInput();
        updateSendState();
    });

    // Enter sends, Shift+Enter inserts a newline. Matches ChatGPT/Claude.
    input.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter" || ev.shiftKey || ev.isComposing) return;
        ev.preventDefault();
        form.requestSubmit();
    });

    form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        if (busy || finalized) return;
        const text = (input.value || "").trim();
        if (!text) return;
        input.value = "";
        autosizeInput();
        updateSendState();
        sendTurn(text);
    });

    // ── Keyboard-aware layout (mobile) ─────────────────────────────────
    // 100dvh handles the iOS Safari URL-bar collapse, but NOT the
    // on-screen keyboard — when it opens, the layout viewport stays the
    // same height while the *visual* viewport shrinks. That leaves the
    // compose bar hidden under the keyboard. Listen to visualViewport
    // and feed the keyboard height into a CSS var so .addspot can
    // shrink accordingly. The compose stays just above the keyboard,
    // and the chat scroll area shrinks instead of getting clipped.
    function bindKeyboard() {
        const vv = window.visualViewport;
        if (!vv) return;
        const stage = document.querySelector(".addspot");
        if (!stage) return;
        // Below this threshold the visual/layout viewport delta is
        // almost certainly browser chrome (URL bar, devtools docked
        // adjustment, headless artifacts) rather than a soft keyboard.
        // Real iOS / Android keyboards are ~250-400px tall — anything
        // under 120px we leave alone so we don't shrink the chat when
        // there's no keyboard up.
        const KEYBOARD_MIN_PX = 120;
        let lastKb = 0;
        function update() {
            const delta = window.innerHeight - vv.height - vv.offsetTop;
            const kb = delta >= KEYBOARD_MIN_PX ? delta : 0;
            if (Math.abs(kb - lastKb) < 1) return;
            lastKb = kb;
            stage.style.setProperty("--addspot-keyboard", kb + "px");
            // When the keyboard opens, the latest bubble can fall
            // behind the compose bar — pin to bottom on every change.
            scrollToBottom();
        }
        vv.addEventListener("resize", update);
        vv.addEventListener("scroll", update);
        update();
    }
    bindKeyboard();

    updateSendState();
    // Kick off the conversation with an empty user turn so the bot
    // delivers its opener (server returns a canned message without
    // calling Gemini).
    sendTurn("");
})();
