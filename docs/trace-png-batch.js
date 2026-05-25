// One-off script: trace every PNG in docs/source-icons/ to clean SVG in
// docs/svg-from-png/. Not committed to the project — temporary tool for
// the stamp-icon pipeline.
const fs = require("fs");
const path = require("path");
const potrace = require("./trace-tool/node_modules/potrace");

const srcDir = path.join(__dirname, "source-icons");
const dstDir = path.join(__dirname, "svg-from-png");
fs.mkdirSync(dstDir, { recursive: true });

const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".png"));
console.log(`Found ${files.length} PNGs in ${srcDir}`);

let done = 0;
files.forEach((file) => {
    const src = path.join(srcDir, file);
    const dst = path.join(dstDir, file.replace(/\.png$/, ".svg"));
    // potrace options tuned for clean line-art:
    //   threshold: 200 (treat near-white as background, keep dark strokes)
    //   color: 'currentColor' so stamps inherit ink color
    //   background: 'transparent'
    //   optTolerance: 0.2 (smooth curves without losing detail)
    //   turdSize: 2 (drop tiny specks)
    potrace.trace(src, {
        threshold: 200,
        color: "currentColor",
        background: "transparent",
        optTolerance: 0.2,
        turdSize: 2,
    }, (err, svg) => {
        if (err) {
            console.error(`FAIL ${file}: ${err.message}`);
            return;
        }
        fs.writeFileSync(dst, svg);
        done++;
        const inSize = fs.statSync(src).size;
        const outSize = fs.statSync(dst).size;
        console.log(`OK  ${file.padEnd(28)}  ${inSize}b PNG -> ${outSize}b SVG`);
        if (done === files.length) {
            console.log(`\nDone: ${done}/${files.length} converted to ${dstDir}`);
        }
    });
});
