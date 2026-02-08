function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

// Alias for clarity when escaping attribute values.
function escapeAttr(value) {
    return escapeHtml(value);
}

module.exports = { escapeHtml, escapeAttr };

