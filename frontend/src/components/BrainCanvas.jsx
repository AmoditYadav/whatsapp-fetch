import React, { useRef, useEffect } from 'react';

export default function BrainCanvas({ agentState }) {
    const canvasRef = useRef(null);

    // State mappings
    const stateMap = { idle: 0, listening: 1, speaking: 2 };

    const colors = [
        '#8052ff', // Electric Iris
        '#ffb829', // Saffron Spark
        '#15846e', // Deep Verdant
        '#ffffff', // Bone White
    ];

    // Helper to parse hex to rgb for blending
    const hexToRgb = (hex) => {
        const bigint = parseInt(hex.replace('#', ''), 16);
        return {
            r: (bigint >> 16) & 255,
            g: (bigint >> 8) & 255,
            b: bigint & 255
        };
    };

    const parsedColors = colors.map(hexToRgb);
    const irisRgb = parsedColors[0]; // #8052ff

    useEffect(() => {
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d', { alpha: false });
        
        // We can use a lower point count because 2D canvas with 'lighter' composite 
        // looks very dense and bright. 2000 points is extremely fast (takes < 1ms).
        const NUM_BRAIN_POINTS = 2000;
        const NUM_AMBIENT_POINTS = 200;
        
        const brainPoints = [];
        const ambientPoints = [];

        // 1. Generate Brain Points (surface of an ellipsoid with folds)
        const ax = 1.05, ay = 0.90, az = 0.80;
        let written = 0;
        
        while (written < NUM_BRAIN_POINTS) {
            const u = Math.random() * Math.PI * 2;
            const v = Math.acos(2 * Math.random() - 1);
            
            let x = ax * Math.sin(v) * Math.cos(u);
            let y = ay * Math.cos(v);
            let z = az * Math.sin(v) * Math.sin(u);

            const normY = y / ay;
            // Longitudinal Fissure
            if (Math.abs(x) < 0.1 && normY > -0.25 && normY < 0.95) {
                continue;
            }

            // Flatten base
            if (y < -ay * 0.6) {
                y = -ay * 0.6 - (y + ay * 0.6) * 0.25;
            }

            // Temporal lobes bulge
            const temporal = Math.max(0, -normY + 0.1) * Math.max(0, 1 - Math.abs(u - Math.PI) / Math.PI);
            x += Math.sign(x) * temporal * 0.12;

            // Surface folds (gyri/sulci)
            const len = Math.sqrt(x*x + y*y + z*z) || 1;
            const nx = x/len, ny = y/len, nz = z/len;
            
            const fold = 0.055 * Math.sin(nx * 10 + nz * 8) * Math.cos(ny * 9) +
                         0.030 * Math.sin(ny * 14 + nx * 6) * Math.cos(nz * 11) +
                         0.015 * Math.cos(nz * 18 + ny * 13) * Math.sin(nx * 7);
            
            const r = len + fold;
            x = nx * r; 
            y = ny * r; 
            z = nz * r;

            // Pre-calculate tangent vectors for surface sliding animation
            const tLen = Math.sqrt(nz*nz + nx*nx) || 1;
            const t1x = nz/tLen, t1y = 0, t1z = -nx/tLen;
            const t2x = ny * t1z - nz * t1y;
            const t2y = nz * t1x - nx * t1z;
            const t2z = nx * t1y - ny * t1x;

            brainPoints.push({
                x, y, z,
                t1x, t1y, t1z,
                t2x, t2y, t2z,
                colorIdx: Math.floor(Math.random() * parsedColors.length),
                speed: 0.3 + Math.random() * 0.5,
                offset: Math.random() * Math.PI * 2,
                baseSize: 1.2 + Math.random() * 1.5,
                alphaMult: Math.max(0.1, Math.min(1.0, (y + 0.8) * 1.5)) // fade out at stem
            });
            written++;
        }

        // 2. Generate Ambient Background Points
        for (let i = 0; i < NUM_AMBIENT_POINTS; i++) {
            ambientPoints.push({
                x: (Math.random() - 0.5) * 12,
                y: (Math.random() - 0.5) * 8,
                z: (Math.random() - 0.5) * 10,
                colorIdx: Math.floor(Math.random() * parsedColors.length),
                speed: 0.1 + Math.random() * 0.2,
                offset: Math.random() * Math.PI * 2,
                baseSize: 1.0 + Math.random() * 2.0
            });
        }

        let animationFrameId;
        let startTime = performance.now();
        let currentState = 0;

        const render = (timeMs) => {
            const time = (timeMs - startTime) * 0.001; // in seconds

            // Resize canvas if needed
            if (canvas.width !== window.innerWidth || canvas.height !== window.innerHeight) {
                canvas.width = window.innerWidth;
                canvas.height = window.innerHeight;
            }

            const w = canvas.width;
            const h = canvas.height;
            const cx = w / 2;
            const cy = h / 2;
            const scale = Math.min(w, h) * 0.35; // base projection scale

            // Solid black background (clears previous frame)
            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = '#000000';
            ctx.fillRect(0, 0, w, h);

            // Use 'lighter' (additive blending) for the sci-fi hologram glow look
            ctx.globalCompositeOperation = 'lighter';

            // Read state dynamically from dataset to avoid closure trapping
            const rawState = canvas.dataset.state;
            const state = rawState ? parseInt(rawState, 10) : 0;

            let amp = 0.014;
            let globalScale = 1.0;
            let colorMix = 0.0; 

            if (state === 1) { // Listening
                globalScale = 0.88;
                amp = 0.005;
                colorMix = 0.82;
            } else if (state === 2) { // Speaking
                amp = 0.028;
                globalScale = 1.0 + Math.sin(time * 7.0) * 0.055;
            }

            // Global rotation matrix (spin on Y, tilt on X)
            const rotY = time * 0.4;
            const cY = Math.cos(rotY), sY = Math.sin(rotY);
            const tilt = -0.25; // tilt down to see fissure
            const cX = Math.cos(tilt), sX = Math.sin(tilt);
            
            // Helper to project and draw a point
            const drawPoint = (p, isAmbient) => {
                const t = time * p.speed + p.offset;
                
                let px = p.x, py = p.y, pz = p.z;

                if (!isAmbient) {
                    px += p.t1x * Math.sin(t * 1.3) * amp + p.t2x * Math.cos(t * 0.9 + 1.57) * amp;
                    py += p.t1y * Math.sin(t * 1.3) * amp + p.t2y * Math.cos(t * 0.9 + 1.57) * amp;
                    pz += p.t1z * Math.sin(t * 1.3) * amp + p.t2z * Math.cos(t * 0.9 + 1.57) * amp;
                    
                    px *= globalScale;
                    py *= globalScale;
                    pz *= globalScale;
                } else {
                    px += Math.sin(t) * 0.4;
                    py += Math.cos(t * 0.7) * 0.3;
                    pz += Math.sin(t * 0.5 + 1.2) * 0.3;
                }

                const rx = cY * px + sY * pz;
                const rz = -sY * px + cY * pz;
                const ry = py;

                const fx = rx;
                const fy = cX * ry - sX * rz;
                const fz = sX * ry + cX * rz;

                const zOffset = 3.6;
                const zTotal = fz + zOffset;
                
                if (zTotal <= 0.1) return;

                const proj = (1.0 / zTotal) * scale;
                const screenX = cx + fx * proj;
                const screenY = cy - fy * proj;

                const size = p.baseSize * proj * 0.4;

                let alpha = isAmbient ? 0.25 : p.alphaMult * Math.min(1.0, 3.0 / zTotal);
                if (alpha < 0.02) return;

                const baseCol = parsedColors[p.colorIdx];
                let finalR = baseCol.r, finalG = baseCol.g, finalB = baseCol.b;
                
                if (!isAmbient && colorMix > 0) {
                    finalR = finalR + (irisRgb.r - finalR) * colorMix;
                    finalG = finalG + (irisRgb.g - finalG) * colorMix;
                    finalB = finalB + (irisRgb.b - finalB) * colorMix;
                }

                ctx.fillStyle = `rgba(${finalR|0}, ${finalG|0}, ${finalB|0}, ${alpha})`;
                ctx.beginPath();
                ctx.arc(screenX, screenY, size, 0, Math.PI * 2);
                ctx.fill();
            };

            for (let i = 0; i < ambientPoints.length; i++) {
                drawPoint(ambientPoints[i], true);
            }
            for (let i = 0; i < brainPoints.length; i++) {
                drawPoint(brainPoints[i], false);
            }

            animationFrameId = requestAnimationFrame(render);
        };

        animationFrameId = requestAnimationFrame(render);

        return () => {
            cancelAnimationFrame(animationFrameId);
        };
    }, []);

    // Sync React state to a DOM attribute so the un-bound render loop can read it
    useEffect(() => {
        if (canvasRef.current) {
            canvasRef.current.dataset.state = stateMap[agentState] ?? 0;
        }
    }, [agentState]);

    return (
        <canvas 
            ref={canvasRef} 
            className="w-full h-full block" 
            style={{ backgroundColor: '#000000' }}
        />
    );
}
