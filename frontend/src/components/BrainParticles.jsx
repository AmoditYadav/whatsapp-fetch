import React, { useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const vertexShader = `
attribute vec3 aColor;
attribute float aSpeed;
attribute float aOffset;
attribute vec3 aNormal;

varying vec3 vColor;
varying float vAlpha;

uniform float uTime;
uniform float uState;

void main() {
    vColor = aColor;

    // Base surface-bound drift — points slide tangentially along the surface
    vec3 pos = position;
    float t   = uTime * aSpeed + aOffset;

    float amp = 0.014;
    if (uState == 1.0) {
        // Listening: pull tighter, shift to iris colour (done in fragment)
        pos *= 0.88;
        amp = 0.005;
    } else if (uState == 2.0) {
        // Speaking: pulse outwards rhythmically
        amp = 0.028;
        float pulse = sin(uTime * 7.0) * 0.055;
        pos += aNormal * pulse;
    }

    // Tangential micro-drift (slide along surface, not inward/outward)
    vec3 tang1 = normalize(cross(aNormal, vec3(0.0, 1.0, 0.001)));
    vec3 tang2 = normalize(cross(aNormal, tang1));
    pos += tang1 * sin(t * 1.3)         * amp;
    pos += tang2 * cos(t * 0.9 + 1.57)  * amp;

    // Slow global Y-axis rotation
    float angle = uTime * 0.06;
    float c = cos(angle), s = sin(angle);
    float nx2 =  c * pos.x + s * pos.z;
    float nz2 = -s * pos.x + c * pos.z;
    pos.x = nx2; pos.z = nz2;

    // Alpha: fade points near the bottom (brain stem area)
    vAlpha = smoothstep(-0.95, -0.3, position.y);

    vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = clamp(280.0 / -mvPos.z, 1.5, 4.0);
    gl_Position  = projectionMatrix * mvPos;
}
`;

const fragmentShader = `
varying vec3 vColor;
varying float vAlpha;
uniform float uState;

void main() {
    // Circular soft dot
    vec2 uv = gl_PointCoord - 0.5;
    float r = length(uv);
    if (r > 0.5) discard;

    vec3 col = vColor;
    if (uState == 1.0) {
        col = mix(col, vec3(0.502, 0.322, 1.0), 0.82); // Electric Iris
    }

    float alpha = vAlpha * (1.0 - smoothstep(0.3, 0.5, r));
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(col, alpha);
}
`;

// ─────────────────────────────────────────────
//  Brain surface geometry builder
// ─────────────────────────────────────────────
function buildBrainGeo(count, palette) {
    const pos     = new Float32Array(count * 3);
    const col     = new Float32Array(count * 3);
    const norms   = new Float32Array(count * 3);
    const speeds  = new Float32Array(count);
    const offsets = new Float32Array(count);

    // Brain axis scales  (x = left/right, y = up/down, z = front/back)
    const ax = 1.05;   // left-right widest
    const ay = 0.90;   // height
    const az = 0.80;   // front-back slightly flatter

    // Longitudinal fissure: gap along x≈0 in the upper brain
    const fissureHalfWidth = 0.10;
    const fissureMaxY      = 0.95;   // fissure exists above this normalised y
    const fissureMinY      = -0.25;  // fissure ends before the base

    let written = 0;
    while (written < count) {
        // Uniform spherical surface sampling
        const u     = Math.random() * Math.PI * 2;
        const v     = Math.acos(2 * Math.random() - 1);
        const sinV  = Math.sin(v);
        const cosV  = Math.cos(v);

        // Ellipsoid surface point
        let x = ax * sinV * Math.cos(u);
        let y = ay * cosV;
        let z = az * sinV * Math.sin(u);

        // ── Longitudinal fissure ──────────────────────────
        // Skip points inside the top fissure groove
        const normY = y / ay;  // -1..1
        if (Math.abs(x) < fissureHalfWidth && normY > fissureMinY && normY < fissureMaxY) {
            continue;
        }

        // ── Flattening at the base (brain doesn't taper to a point) ──
        if (y < -ay * 0.6) {
            y = -ay * 0.6 - (y + ay * 0.6) * 0.25;
        }

        // ── Temporal lobe bulge (each side, lower-front) ──────────
        const temporalFactor = Math.max(0, -normY + 0.1) * Math.max(0, 1 - Math.abs(u - Math.PI) / Math.PI);
        x += Math.sign(x) * temporalFactor * 0.12;

        // ── Gyri / Sulci surface displacement ────────────────────
        // We displace along the ellipsoid normal (outward/inward)
        const len  = Math.sqrt(x * x + y * y + z * z) || 1;
        const nx   = x / len, ny = y / len, nz = z / len;

        const fold =
            0.055 * Math.sin(nx * 10.0 + nz * 8.0) * Math.cos(ny * 9.0) +
            0.030 * Math.sin(ny * 14.0 + nx * 6.0) * Math.cos(nz * 11.0) +
            0.015 * Math.cos(nz * 18.0 + ny * 13.0) * Math.sin(nx * 7.0);

        const r = len + fold;
        x = nx * r;
        y = ny * r;
        z = nz * r;

        pos[written * 3]     = x;
        pos[written * 3 + 1] = y;
        pos[written * 3 + 2] = z;

        // Store outward normal for tangential animation
        norms[written * 3]     = nx;
        norms[written * 3 + 1] = ny;
        norms[written * 3 + 2] = nz;

        const c = palette[Math.floor(Math.random() * palette.length)];
        col[written * 3]     = c.r;
        col[written * 3 + 1] = c.g;
        col[written * 3 + 2] = c.b;

        speeds[written]  = 0.3 + Math.random() * 0.5;
        offsets[written] = Math.random() * Math.PI * 2;

        written++;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos,     3));
    geo.setAttribute('aColor',   new THREE.BufferAttribute(col,     3));
    geo.setAttribute('aNormal',  new THREE.BufferAttribute(norms,   3));
    geo.setAttribute('aSpeed',   new THREE.BufferAttribute(speeds,  1));
    geo.setAttribute('aOffset',  new THREE.BufferAttribute(offsets, 1));
    return geo;
}

// ─────────────────────────────────────────────
//  Sparse ambient points in the void
// ─────────────────────────────────────────────
function buildAmbientGeo(count, palette) {
    const pos     = new Float32Array(count * 3);
    const col     = new Float32Array(count * 3);
    const speeds  = new Float32Array(count);
    const offsets = new Float32Array(count);

    for (let i = 0; i < count; i++) {
        pos[i * 3]     = (Math.random() - 0.5) * 14;
        pos[i * 3 + 1] = (Math.random() - 0.5) *  8;
        pos[i * 3 + 2] = (Math.random() - 0.5) * 10;

        const c = palette[Math.floor(Math.random() * palette.length)];
        col[i * 3]     = c.r;
        col[i * 3 + 1] = c.g;
        col[i * 3 + 2] = c.b;

        speeds[i]  = 0.1 + Math.random() * 0.2;
        offsets[i] = Math.random() * Math.PI * 2;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos,     3));
    geo.setAttribute('aColor',   new THREE.BufferAttribute(col,     3));
    geo.setAttribute('aSpeed',   new THREE.BufferAttribute(speeds,  1));
    geo.setAttribute('aOffset',  new THREE.BufferAttribute(offsets, 1));
    return geo;
}

// Minimal ambient shader
const ambientVert = `
attribute vec3 aColor; attribute float aSpeed; attribute float aOffset;
varying vec3 vColor; uniform float uTime;
void main() {
    vColor = aColor;
    vec3 p = position;
    float t = uTime * aSpeed + aOffset;
    p.x += sin(t) * 0.4; p.y += cos(t * 0.7) * 0.3; p.z += sin(t * 0.5 + 1.2) * 0.3;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = clamp(160.0 / -mv.z, 1.0, 2.5);
    gl_Position  = projectionMatrix * mv;
}`;

const ambientFrag = `
varying vec3 vColor;
void main() {
    if (length(gl_PointCoord - 0.5) > 0.5) discard;
    gl_FragColor = vec4(vColor, 0.18);
}`;

// ─────────────────────────────────────────────
//  Main component
// ─────────────────────────────────────────────
export default function BrainParticles({ agentState }) {
    const BRAIN_COUNT   = 6000;
    const AMBIENT_COUNT = 350;
    const stateMap = { idle: 0.0, listening: 1.0, speaking: 2.0 };

    const palette = useMemo(() => [
        new THREE.Color('#8052ff'),
        new THREE.Color('#ffb829'),
        new THREE.Color('#15846e'),
        new THREE.Color('#ffffff'),
    ], []);

    const uniforms = useMemo(() => ({
        uTime:  { value: 0 },
        uState: { value: 0.0 }
    }), []);

    const ambientUniforms = useMemo(() => ({
        uTime: { value: 0 }
    }), []);

    const brainGeo   = useMemo(() => buildBrainGeo(BRAIN_COUNT, palette),   [palette]);
    const ambientGeo = useMemo(() => buildAmbientGeo(AMBIENT_COUNT, palette), [palette]);

    useFrame(({ clock }) => {
        const t = clock.getElapsedTime();
        uniforms.uTime.value  = t;
        uniforms.uState.value = stateMap[agentState] ?? 0.0;
        ambientUniforms.uTime.value = t;
    });

    return (
        <group>
            <points geometry={brainGeo}>
                <shaderMaterial
                    vertexShader={vertexShader}
                    fragmentShader={fragmentShader}
                    uniforms={uniforms}
                    transparent
                    depthWrite={false}
                />
            </points>

            <points geometry={ambientGeo}>
                <shaderMaterial
                    vertexShader={ambientVert}
                    fragmentShader={ambientFrag}
                    uniforms={ambientUniforms}
                    transparent
                    depthWrite={false}
                />
            </points>
        </group>
    );
}
