import React, { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// 3D Simplex Noise by Stefan Gustavson / Ashima Arts
const simplexNoiseGLSL = `
vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x, 289.0);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}

float snoise(vec3 v){
  const vec2  C = vec2(1.0/6.0, 1.0/3.0) ;
  const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i  = floor(v + dot(v, C.yyy) );
  vec3 x0 =   v - i + dot(i, C.xxx) ;

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min( g.xyz, l.zxy );
  vec3 i2 = max( g.xyz, l.zxy );

  vec3 x1 = x0 - i1 + 1.0 * C.xxx;
  vec3 x2 = x0 - i2 + 2.0 * C.xxx;
  vec3 x3 = x0 - D.yyy;

  i = mod(i, 289.0 );
  vec4 p = permute( permute( permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0 ))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0 ))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0 ));

  float n_ = 0.142857142857; // 1.0/7.0
  vec3  ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z *ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_ );

  vec4 x = x_ *ns.x + ns.yyyy;
  vec4 y = y_ *ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4( x.xy, y.xy );
  vec4 b1 = vec4( x.zw, y.zw );

  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy ;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww ;

  vec3 p0 = vec3(a0.xy,h.x);
  vec3 p1 = vec3(a0.zw,h.y);
  vec3 p2 = vec3(a1.xy,h.z);
  vec3 p3 = vec3(a1.zw,h.w);

  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot( m*m, vec4( dot(p0,x0), dot(p1,x1),
                                dot(p2,x2), dot(p3,x3) ) );
}
`;

const vertexShader = `
${simplexNoiseGLSL}

attribute vec3 aPos;
attribute vec3 aColor;

varying vec3 vColor;
varying float vState;

uniform float uTime;
uniform float uState; // 0.0 = idle, 1.0 = listening, 2.0 = speaking

void main() {
    vColor = aColor;
    vState = uState;

    vec3 pos = aPos;

    // Dynamic state transitions
    float noiseFreq = 1.5;
    float noiseAmp = 0.12;
    float pulse = 0.0;

    if (uState == 1.0) {
        // Listening: Contract particles towards center, lower noise activity
        pos *= 0.85;
        noiseAmp = 0.06;
    } else if (uState == 2.0) {
        // Speaking: Expand noise, pulse rhythmically
        noiseAmp = 0.28;
        noiseFreq = 2.8;
        pulse = sin(uTime * 10.0) * 0.14;
    }

    // Apply Curl-like Simplex Noise drift
    vec3 noiseInput = pos * noiseFreq + vec3(0.0, 0.0, uTime * 0.4);
    vec3 drift = vec3(
        snoise(noiseInput),
        snoise(noiseInput + vec3(12.3, 23.4, 34.5)),
        snoise(noiseInput + vec3(45.6, 56.7, 67.8))
    );

    // Apply radial pulsing and noise drift
    pos += normalize(pos) * pulse;
    pos += drift * noiseAmp;

    // Apply slow global rotation
    float angle = uTime * 0.04;
    float c = cos(angle);
    float s = sin(angle);
    mat2 rotY = mat2(c, -s, s, c);
    pos.xz = rotY * pos.xz;

    // Apply instanced transforms (scale/rotation of local triangular geometry)
    vec4 localPos = instanceMatrix * vec4(position, 1.0);
    vec4 mvPosition = modelViewMatrix * vec4(pos + localPos.xyz, 1.0);

    gl_Position = projectionMatrix * mvPosition;
}
`;

const fragmentShader = `
varying vec3 vColor;
varying float vState;

void main() {
    vec3 color = vColor;

    if (vState == 1.0) {
        // Listening: Heavy shift to Electric Iris (#8052ff)
        vec3 iris = vec3(0.502, 0.322, 1.0);
        color = mix(color, iris, 0.88);
    }

    gl_FragColor = vec4(color, 1.0);
}
`;

// Shaders for the ambient sparse background particles
const ambientVertexShader = `
${simplexNoiseGLSL}

attribute vec3 aPos;
attribute vec3 aColor;

varying vec3 vColor;

uniform float uTime;

void main() {
    vColor = aColor;

    vec3 pos = aPos;

    // Slow, large-scale slow drift in space
    vec3 noiseInput = pos * 0.3 + vec3(0.0, uTime * 0.1, 0.0);
    vec3 drift = vec3(
        snoise(noiseInput),
        snoise(noiseInput + vec3(5.0, 10.0, 15.0)),
        snoise(noiseInput + vec3(20.0, 25.0, 30.0))
    );

    pos += drift * 1.5;

    vec4 localPos = instanceMatrix * vec4(position, 1.0);
    vec4 mvPosition = modelViewMatrix * vec4(pos + localPos.xyz, 1.0);

    gl_Position = projectionMatrix * mvPosition;
}
`;

const ambientFragmentShader = `
varying vec3 vColor;

void main() {
    // Semi-transparent ambient particles for depth
    gl_FragColor = vec4(vColor, 0.3);
}
`;

export default function BrainParticles({ agentState }) {
    const mainCount = 65000;
    const ambientCount = 3500;

    const stateMap = {
        idle: 0.0,
        listening: 1.0,
        speaking: 2.0
    };

    const uniforms = useMemo(() => ({
        uTime: { value: 0 },
        uState: { value: 0.0 }
    }), []);

    const ambientUniforms = useMemo(() => ({
        uTime: { value: 0 }
    }), []);

    // Color Palette matching tokens
    const palette = useMemo(() => [
        new THREE.Color('#8052ff'), // Electric Iris
        new THREE.Color('#ffb829'), // Saffron Spark
        new THREE.Color('#15846e'), // Deep Verdant
        new THREE.Color('#ffffff')  // Bone White
    ], []);

    // Generate main brain volume coordinates (two hemispheres + folds)
    const [mainPositions, mainColors] = useMemo(() => {
        const pos = new Float32Array(mainCount * 3);
        const col = new Float32Array(mainCount * 3);

        for (let i = 0; i < mainCount; i++) {
            const isLeft = Math.random() > 0.5;
            const xSign = isLeft ? -1.0 : 1.0;

            // Centers for left and right hemispheres
            const cx = 0.52 * xSign;
            const cy = 0.0;
            const cz = 0.0;

            const u = Math.random() * Math.PI * 2;
            const v = Math.random() * Math.PI;
            // Bias density towards the center for organic structure
            const r = 0.35 + 0.65 * Math.pow(Math.random(), 3.0);

            // Ellipsoid dimensions
            const rx = 0.72;
            const ry = 0.95;
            const rz = 0.72;

            let px = cx + rx * r * Math.sin(v) * Math.cos(u);
            let py = cy + ry * r * Math.sin(v) * Math.sin(u);
            let pz = cz + rz * r * Math.cos(v);

            // Add folds (sulci/gyri pattern)
            const foldPattern = Math.sin(px * 11.0) * Math.sin(py * 11.0) * Math.sin(pz * 11.0) * 0.07;
            px += foldPattern;
            py += foldPattern;
            pz += foldPattern;

            pos[i * 3] = px;
            pos[i * 3 + 1] = py;
            pos[i * 3 + 2] = pz;

            // Colors
            const color = palette[Math.floor(Math.random() * palette.length)];
            col[i * 3] = color.r;
            col[i * 3 + 1] = color.g;
            col[i * 3 + 2] = color.b;
        }
        return [pos, col];
    }, [palette]);

    // Generate sparse ambient field coordinates
    const [ambientPositions, ambientColors] = useMemo(() => {
        const pos = new Float32Array(ambientCount * 3);
        const col = new Float32Array(ambientCount * 3);

        for (let i = 0; i < ambientCount; i++) {
            // Scattered throughout a wide viewport volume
            pos[i * 3] = (Math.random() - 0.5) * 16.0;
            pos[i * 3 + 1] = (Math.random() - 0.5) * 10.0;
            pos[i * 3 + 2] = (Math.random() - 0.5) * 12.0;

            // Pick randomly from palette
            const color = palette[Math.floor(Math.random() * palette.length)];
            col[i * 3] = color.r;
            col[i * 3 + 1] = color.g;
            col[i * 3 + 2] = color.b;
        }
        return [pos, col];
    }, [palette]);

    // Apply instance matrix transforms for particles
    const mainMeshRef = useRef();
    const ambientMeshRef = useRef();

    useFrame((state) => {
        const elapsed = state.clock.getElapsedTime();
        uniforms.uTime.value = elapsed;
        uniforms.uState.value = stateMap[agentState] ?? 0.0;
        ambientUniforms.uTime.value = elapsed;
    });

    return (
        <group>
            {/* The main brain structure */}
            <instancedMesh ref={mainMeshRef} args={[null, null, mainCount]}>
                <tetrahedronGeometry args={[0.012]}>
                    <instancedBufferAttribute
                        attach="attributes-aPos"
                        args={[mainPositions, 3]}
                    />
                    <instancedBufferAttribute
                        attach="attributes-aColor"
                        args={[mainColors, 3]}
                    />
                </tetrahedronGeometry>
                <shaderMaterial
                    vertexShader={vertexShader}
                    fragmentShader={fragmentShader}
                    uniforms={uniforms}
                    wireframe={true}
                    depthWrite={false}
                    transparent={true}
                />
            </instancedMesh>

            {/* Sparse ambient background field */}
            <instancedMesh ref={ambientMeshRef} args={[null, null, ambientCount]}>
                <tetrahedronGeometry args={[0.025]}>
                    <instancedBufferAttribute
                        attach="attributes-aPos"
                        args={[ambientPositions, 3]}
                    />
                    <instancedBufferAttribute
                        attach="attributes-aColor"
                        args={[ambientColors, 3]}
                    />
                </tetrahedronGeometry>
                <shaderMaterial
                    vertexShader={ambientVertexShader}
                    fragmentShader={ambientFragmentShader}
                    uniforms={ambientUniforms}
                    wireframe={true}
                    depthWrite={false}
                    transparent={true}
                />
            </instancedMesh>
        </group>
    );
}
