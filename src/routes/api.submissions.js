const express = require("express");
const { z } = require("zod");
const { prisma } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { submitLimiter } = require("../middleware/rateLimit");

const router = express.Router();

const submissionSchema = z.object({
    type: z.enum(["new_place", "edit_place"]),
    targetPlaceId: z.number().int().optional(),
    payload: z.object({
        name: z.string().min(2).max(100),
        addressLine: z.string().min(2).max(120),
        city: z.string().min(1).max(80),
        region: z.string().max(80).optional().nullable(),
        postalCode: z.string().max(20).optional().nullable(),
        country: z.string().min(2).max(2), // ISO2, e.g. ES
        lat: z.union([z.string(), z.number()]),
        lng: z.union([z.string(), z.number()]),
        priceLevel: z.number().int().min(1).max(3),
        stylesJson: z.string(), // JSON array string
        dineIn: z.boolean().optional(),
        takeaway: z.boolean().optional(),
        delivery: z.boolean().optional(),
        websiteUrl: z.string().url().optional().nullable(),
        googleMapsUrl: z.string().url().optional().nullable(),
        instagramUrl: z.string().url().optional().nullable(),
        status: z.enum(["active", "closed", "temp_closed"]).optional(),
    }),
});

router.post("/", requireAuth, submitLimiter, async (req, res) => {
    const parsed = submissionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const { type, targetPlaceId, payload } = parsed.data;

    // duplicate heuristic for new places
    if (type === "new_place") {
        const dup = await prisma.place.findFirst({
            where: {
                name: { contains: payload.name },
                city: { contains: payload.city },
            },
        });
        // don't block, just warn
        if (dup) {
            // still allow submission; moderation can merge
        }
    }

    const sub = await prisma.submission.create({
        data: {
            userId: req.session.user.id,
            type,
            targetPlaceId: targetPlaceId || null,
            payloadJson: JSON.stringify({
                ...payload,
                // ensure booleans default
                dineIn: payload.dineIn ?? true,
                takeaway: payload.takeaway ?? true,
                delivery: payload.delivery ?? false,
                status: payload.status ?? "active",
            }),
        },
    });

    res.json({ ok: true, submission: sub });
});

router.get("/me", requireAuth, async (req, res) => {
    const subs = await prisma.submission.findMany({
        where: { userId: req.session.user.id },
        orderBy: { createdAt: "desc" },
        take: 100,
    });
    res.json({ ok: true, submissions: subs });
});

module.exports = router;
