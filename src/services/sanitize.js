const sanitizeHtml = require("sanitize-html");

function sanitizeRichText(html) {
    const input = typeof html === "string" ? html : "";
    return sanitizeHtml(input, {
        allowedTags: [
            "p",
            "br",
            "strong",
            "b",
            "em",
            "i",
            "u",
            "ul",
            "ol",
            "li",
            "a",
            "h2",
            "h3",
            "blockquote",
            "code",
            "pre",
        ],
        allowedAttributes: {
            a: ["href", "target", "rel"],
        },
        transformTags: {
            a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer", target: "_blank" }, true),
        },
        // Disallow unknown URL schemes; keep it strict.
        allowedSchemes: ["http", "https", "mailto"],
        allowProtocolRelative: false,
    });
}

module.exports = { sanitizeRichText };

