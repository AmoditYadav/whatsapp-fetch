import React, { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// Lightweight vertex shader: sin/cos drift instead of Simplex noise
const vertexShader = `
attribute vec3 aColor;
attribute float aSpeed;
attribute float aOffset;

varying vec3 vColor;
varying float vAlpha;

uniform float uTime;
uniform float uState;

void main() {
    vColor = aColor;

    vec3 pos = position;
    float t = uTime * aSpeed + aOffset;

    float amp = 0.08;
    if (uState == 1.0) {
        // Listening: tighten towards center
        pos *= 0.82;
        amp = 0.03;
    } else if (uState == 2.0) {
        // Speaking: outward pulse
        amp = 0.18;
        float pulse = sin(uTime * 8.0) * 0.12;
        pos += normalize(pos) * pulse;
    }

    // Simple, cheap drift using sin/cos
    pos.x += sin(t * 1.1) * amp;
    pos.y += cos(t * 0.9) * amp;
    pos.z += sin(t * 0.7 + 1.3) * amp;

    // Slow Y-axis rotation
    float angle = uTime * 0.05;
    float c = cos(angle);
    float s = sin(angle);
    float nx = c * pos.x - s * pos.z;
    float nz = s * pos.x + c * pos.z;
    pos.x = nx;
    pos.z = nz;

    // Fade out particles near the edge of the brain for organic look
    float dist = length(position);
    vAlpha = 1.0 - smoothstep(0.6, 1.2, dist);

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = (2.5 / -mvPosition.z) * 300.0;
    gl_Position = projectionMatrix * mvPosition;
}
`;

const fragmentShader = `
varying vec3 vColor;
varying float vAlpha;

uniform float uState;

void main() {
    // Soft circular point shape
    vec2 uv = gl_PointCoord - 0.5;
    float r = length(uv);
    if (r > 0.5) discard;
    float alpha = vAlpha * (1.0 - smoothstep(0.3, 0.5, r));

    vec3 color = vColor;
    if (uState == 1.0) {
        // Listening: fade to Electric Iris
        color = mix(color, vec3(0.502, 0.322, 1.0), 0.85);
    }

    gl_FragColor = vec4(color, alpha);
}
`;

const ambientVertexShader = `
attribute vec3 aColor;
attribute float aSpeed;
attribute float aOffset;
varying vec3 vColor;

uniform float uTime;

void main() {
    vColor = aColor;

    vec3 pos = position;
    float t = uTime * aSpeed * 0.4 + aOffset;
    pos.x += sin(t) * 0.5;
    pos.y += cos(t * 0.8) * 0.4;
    pos.z += sin(t * 0.6 + 2.0) * 0.4;

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = (1.5 / -mvPosition.z) * 300.0;
    gl_Position = projectionMatrix * mvPosition;
}
`;

const ambientFragmentShader = `
varying vec3 vColor;
void main() {
    vec2 uv = gl_PointCoord - 0.5;
    if (length(uv) > 0.5) discard;
    gl_FragColor = vec4(vColor, 0.25);
}
`;

export default function BrainParticles({ agentState }) {
    const BRAIN_COUNT = 5000;
    const AMBIENT_COUNT = 400;

    const stateMap = { idle: 0.0, listening: 1.0, speaking: 2.0 };

    const palette = useMemo(() => [
        new THREE.Color('#8052ff'),
        new THREE.Color('#ffb829'),
        new THREE.Color('#15846e'),
        new THREE.Color('#ffffff'),
    ], []);

    const uniforms = useMemo(() => ({
        uTime: { value: 0 },
        uState: { value: 0.0 }
    }), []);

    const ambientUniforms = useMemo(() => ({
        uTime: { value: 0 }
    }), []);

    // Generate brain-shaped point cloud (two lopsided ellipsoid hemispheres)
    const brainGeo = useMemo(() => {
        const positions = new Float32Array(BRAIN_COUNT * 3);
        const colors    = new Float32Array(BRAIN_COUNT * 3);
        const speeds    = new Float32Array(BRAIN_COUNT);
        const offsets   = new Float32Array(BRAIN_COUNT);

        for (let i = 0; i < BRAIN_COUNT; i++) {
            const isLeft = Math.random() > 0.5;
            const cx = isLeft ? -0.5 : 0.5;

            // Rejection sampling to fill an ellipsoid
            let px, py, pz, dist;
            do {
                px = (Math.random() * 2 - 1) * 0.72;
                py = (Math.random() * 2 - 1) * 0.95;
                pz = (Math.random() * 2 - 1) * 0.72;
                dist = (px / 0.72) ** 2 + (py / 0.95) ** 2 + (pz / 0.72) ** 2;
            } while (dist > 1.0);

            // Slight fold pattern (cheap)
            const fold = Math.sin(px * 8) * Math.sin(py * 8) * 0.04;

            positions[i * 3]     = cx + px + fold;
            positions[i * 3 + 1] = py + fold;
            positions[i * 3 + 2] = pz + fold;

            const c = palette[Math.floor(Math.random() * palette.length)];
            colors[i * 3]     = c.r;
            colors[i * 3 + 1] = c.g;
            colors[i * 3 + 2] = c.b;

            speeds[i]  = 0.4 + Math.random() * 0.6;
            offsets[i] = Math.random() * Math.PI * 2;
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('aColor',   new THREE.BufferAttribute(colors, 3));
        geo.setAttribute('aSpeed',   new THREE.BufferAttribute(speeds, 1));
        geo.setAttribute('aOffset',  new THREE.BufferAttribute(offsets, 1));
        return geo;
    }, [palette]);

    const ambientGeo = useMemo(() => {
        const positions = new Float32Array(AMBIENT_COUNT * 3);
        const colors    = new Float32Array(AMBIENT_COUNT * 3);
        const speeds    = new Float32Array(AMBIENT_COUNT);
        const offsets   = new Float32Array(AMBIENT_COUNT);

        for (let i = 0; i < AMBIENT_COUNT; i++) {
            positions[i * 3]     = (Math.random() - 0.5) * 14;
            positions[i * 3 + 1] = (Math.random() - 0.5) * 8;
            positions[i * 3 + 2] = (Math.random() - 0.5) * 10;

            const c = palette[Math.floor(Math.random() * palette.length)];
            colors[i * 3]     = c.r;
            colors[i * 3 + 1] = c.g;
            colors[i * 3 + 2] = c.b;

            speeds[i]  = 0.2 + Math.random() * 0.4;
            offsets[i] = Math.random() * Math.PI * 2;
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('aColor',   new THREE.BufferAttribute(colors, 3));
        geo.setAttribute('aSpeed',   new THREE.BufferAttribute(speeds, 1));
        geo.setAttribute('aOffset',  new THREE.BufferAttribute(offsets, 1));
        return geo;
    }, [palette]);

    useFrame((state) => {
        const t = state.clock.getElapsedTime();
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
                    vertexShader={ambientVertexShader}
                    fragmentShader={ambientFragmentShader}
                    uniforms={ambientUniforms}
                    transparent
                    depthWrite={false}
                />
            </points>
        </group>
    );
}
