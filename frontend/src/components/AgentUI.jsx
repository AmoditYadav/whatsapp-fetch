import React, { useState, useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import BrainParticles from './BrainParticles';

export default function AgentUI() {
    const [agentState, setAgentState] = useState('idle'); // 'idle' | 'listening' | 'speaking'
    const [caption, setCaption] = useState('');

    useEffect(() => {
        // SSE connection to the Node.js backend
        const sseUrl = `${window.location.origin}/api/jarvis/stream`;
        let eventSource;

        function connect() {
            eventSource = new EventSource(sseUrl);

            eventSource.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.state) {
                        setAgentState(data.state);
                    }
                    if (data.caption !== undefined) {
                        setCaption(data.caption);
                    }
                } catch (e) {
                    console.error('Failed to parse SSE payload:', e);
                }
            };

            eventSource.onerror = () => {
                console.warn('SSE disconnected. Reconnecting in 3s...');
                eventSource.close();
                setTimeout(connect, 3000);
            };
        }

        connect();

        return () => {
            if (eventSource) {
                eventSource.close();
            }
        };
    }, []);

    // Split caption into active words (last 5 words bone-white, preceding words in silver-mist)
    const renderCaption = () => {
        if (!caption) return null;
        const words = caption.split(' ');
        const highlightCount = 6; // last 6 words are active bone white
        
        if (words.length <= highlightCount) {
            return <span className="text-bone">{caption}</span>;
        }

        const trailingIndex = words.length - highlightCount;
        const trailingText = words.slice(0, trailingIndex).join(' ');
        const activeText = words.slice(trailingIndex).join(' ');

        return (
            <>
                <span className="text-silver">{trailingText} </span>
                <span className="text-bone">{activeText}</span>
            </>
        );
    };

    return (
        <div className="relative w-screen h-screen bg-void text-bone m-0 p-0 overflow-hidden select-none">
            {/* R3F WebGL Canvas */}
            <div className="absolute inset-0 w-full h-full z-0">
                <Canvas
                    camera={{ position: [0, 0, 3.2], fov: 45 }}
                    gl={{ antialias: false, alpha: false, powerPreference: 'low-power' }}
                    dpr={1}
                    frameloop="always"
                    performance={{ min: 0.5 }}
                    onCreated={({ gl }) => {
                        gl.setClearColor('#000000', 1.0);
                    }}
                >
                    <ambientLight intensity={1.5} />
                    <BrainParticles agentState={agentState} />
                </Canvas>
            </div>

            {/* Speach Caption Overlay */}
            {agentState === 'speaking' && caption && (
                <div 
                    className="absolute bottom-120 left-1/2 -translate-x-1/2 w-full max-w-[800px] text-center z-10 font-sans pointer-events-none px-4 animate-fade-in"
                    style={{
                        fontSize: '48px',
                        fontWeight: 400,
                        letterSpacing: '-1.68px',
                        lineHeight: 1.2
                    }}
                >
                    {renderCaption()}
                </div>
            )}

            {/* Listening Indicator overlay (purely typographic/minimal) */}
            {agentState === 'listening' && (
                <div 
                    className="absolute bottom-120 left-1/2 -translate-x-1/2 w-full max-w-[800px] text-center z-10 font-sans text-iris animate-pulse pointer-events-none"
                    style={{
                        fontSize: '42px',
                        fontWeight: 400,
                        letterSpacing: '-1.68px'
                    }}
                >
                    LISTENING...
                </div>
            )}
        </div>
    );
}
