import React, { useState, useEffect, useRef } from 'react';

const generateMockNetworkData = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let str = '';
    for (let i = 0; i < 32; i++) {
        str += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `RECV: [${str}] OK`;
};

export default function AgentUI() {
    const [agentState, setAgentState] = useState('idle');
    const [spokenText, setSpokenText] = useState('');
    const [cpuUsage, setCpuUsage] = useState(14);
    const [ramUsage, setRamUsage] = useState(8.2);
    const [networkLog, setNetworkLog] = useState([]);
    const [time, setTime] = useState('');

    const cpuCanvasRef = useRef(null);
    const audioCanvasRef = useRef(null);
    const cpuHistory = useRef(new Array(50).fill(14));

    useEffect(() => {
        const sseUrl = `${window.location.origin}/api/jarvis/stream`;
        let eventSource;
        function connect() {
            eventSource = new EventSource(sseUrl);
            eventSource.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'state' || data.state) {
                        setAgentState(data.value || data.state);
                    }
                    if (data.type === 'caption' || data.caption !== undefined) {
                        setSpokenText(data.text || data.caption);
                    }
                } catch (e) {}
            };
            eventSource.onerror = () => {
                eventSource.close();
                setTimeout(connect, 3000);
            };
        }
        connect();
        return () => eventSource && eventSource.close();
    }, []);

    useEffect(() => {
        const interval = setInterval(() => {
            const now = new Date();
            setTime(now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 2 }).replace('.', ':'));
            
            const newCpu = Math.max(2, Math.min(98, cpuUsage + (Math.random() * 20 - 10)));
            setCpuUsage(newCpu);
            cpuHistory.current.push(newCpu);
            if (cpuHistory.current.length > 50) cpuHistory.current.shift();

            setRamUsage(prev => Math.max(6.0, Math.min(15.0, prev + (Math.random() * 0.4 - 0.2))));

            setNetworkLog(prev => {
                const newLog = [...prev, generateMockNetworkData()];
                if (newLog.length > 15) newLog.shift();
                return newLog;
            });
        }, 100);
        return () => clearInterval(interval);
    }, [cpuUsage]);

    useEffect(() => {
        const canvas = cpuCanvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0, 0, w, h);
        ctx.strokeStyle = '#00f3ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        const step = w / 50;
        for (let i = 0; i < cpuHistory.current.length; i++) {
            const x = i * step;
            const y = h - (cpuHistory.current[i] / 100) * h;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
        
        ctx.fillStyle = 'rgba(0, 243, 255, 0.1)';
        ctx.lineTo(w, h);
        ctx.lineTo(0, h);
        ctx.fill();
    }, [cpuUsage]);

    useEffect(() => {
        const canvas = audioCanvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        let animationId;
        const renderAudio = () => {
            const w = canvas.width;
            const h = canvas.height;
            ctx.clearRect(0, 0, w, h);
            const bars = 64;
            const barWidth = (w / bars) - 2;
            ctx.fillStyle = agentState === 'speaking' ? '#00f3ff' : '#0088ff';
            for (let i = 0; i < bars; i++) {
                const heightMult = agentState === 'speaking' ? (Math.random() * 0.8 + 0.2) : (Math.random() * 0.1 + 0.05);
                const barHeight = heightMult * h;
                const x = i * (barWidth + 2);
                const y = h - barHeight;
                ctx.fillRect(x, y, barWidth, barHeight);
                ctx.shadowBlur = 10;
                ctx.shadowColor = ctx.fillStyle;
            }
            animationId = requestAnimationFrame(renderAudio);
        };
        renderAudio();
        return () => cancelAnimationFrame(animationId);
    }, [agentState]);

    return (
        <div 
            className="fixed inset-0 w-screen h-screen overflow-hidden text-[#00f3ff] font-mono select-none"
            style={{
                backgroundColor: '#050914',
                backgroundImage: 'linear-gradient(rgba(0, 243, 255, 0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(0, 243, 255, 0.03) 1px, transparent 1px)',
                backgroundSize: '40px 40px',
                textTransform: 'uppercase',
                fontSize: '12px',
                letterSpacing: '1px'
            }}
        >
            <style>{`
                @keyframes spin-cw { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
                @keyframes spin-ccw { from { transform: rotate(360deg); } to { transform: rotate(0deg); } }
                @keyframes pulse-core { 0% { box-shadow: 0 0 20px #00f3ff; } 50% { box-shadow: 0 0 60px #00f3ff, inset 0 0 20px #00f3ff; } 100% { box-shadow: 0 0 20px #00f3ff; } }
                @keyframes pulse-speak { 0% { box-shadow: 0 0 40px #ff2a2a; border-color: #ff2a2a; } 50% { box-shadow: 0 0 100px #ff2a2a, inset 0 0 40px #ff2a2a; border-color: #ff2a2a; } 100% { box-shadow: 0 0 40px #ff2a2a; border-color: #ff2a2a; } }
            `}</style>

            <div className="absolute top-8 left-8 w-[300px] flex flex-col gap-6">
                <div className="relative border-l-2 border-t-2 border-[#00f3ff] p-4" style={{ clipPath: 'polygon(0 0, 100% 0, 100% calc(100% - 15px), calc(100% - 15px) 100%, 0 100%)' }}>
                    <div className="text-white mb-2 font-bold tracking-widest">SYS.CPU.MATRIX // {cpuUsage.toFixed(1)}%</div>
                    <canvas ref={cpuCanvasRef} width={260} height={80} className="w-full h-[80px]" />
                </div>

                <div className="relative border-l-2 border-[#0088ff] p-4 bg-[#0088ff]/5">
                    <div className="text-white mb-4 font-bold tracking-widest">MEM.BANK.ALLOC // {ramUsage.toFixed(1)} GB / 16.0 GB</div>
                    <div className="flex gap-1 h-4 w-full">
                        {Array.from({ length: 20 }).map((_, i) => (
                            <div key={i} className="flex-1" style={{ backgroundColor: i < (ramUsage / 16) * 20 ? '#00f3ff' : '#00f3ff22', boxShadow: i < (ramUsage / 16) * 20 ? '0 0 5px #00f3ff' : 'none' }} />
                        ))}
                    </div>
                </div>

                <div className="relative border-b-2 border-l-2 border-[#00f3ff] p-4 h-[200px] overflow-hidden">
                    <div className="text-[#0088ff] mb-2 font-bold tracking-widest">NET.STREAM.UPLINK</div>
                    <div className="flex flex-col justify-end h-[140px] opacity-70">
                        {networkLog.map((log, i) => <div key={i}>{log}</div>)}
                    </div>
                </div>
            </div>

            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] flex items-center justify-center">
                <div className="absolute w-[500px] h-[500px] rounded-full border border-[#00f3ff]/20" style={{ animation: 'spin-cw 30s linear infinite', borderStyle: 'dashed', borderWidth: '1px' }} />
                <div className="absolute w-[440px] h-[440px] rounded-full border-2 border-[#0088ff]/40" style={{ animation: 'spin-ccw 20s linear infinite', borderStyle: 'dotted' }} />
                <div className="absolute w-[360px] h-[360px] rounded-full border-4 border-[#00f3ff]/60" style={{ animation: 'spin-cw 15s linear infinite', borderTopColor: 'transparent', borderBottomColor: 'transparent' }} />
                <div className="absolute w-[300px] h-[300px] rounded-full border border-[#ffffff]/30" style={{ animation: 'spin-ccw 10s linear infinite', borderStyle: 'dashed', borderWidth: '2px' }} />
                <div className="absolute w-[220px] h-[220px] rounded-full border-8 border-[#00f3ff]" style={{ animation: 'spin-cw 8s linear infinite', borderLeftColor: 'transparent', borderRightColor: 'transparent', opacity: 0.8, boxShadow: '0 0 30px #00f3ff' }} />
                
                <div 
                    className="absolute w-[120px] h-[120px] rounded-full bg-[#050914] flex flex-col items-center justify-center z-10 border-2"
                    style={{
                        animation: agentState === 'speaking' ? 'pulse-speak 0.2s infinite' : agentState === 'listening' ? 'pulse-core 1s infinite' : 'none',
                        borderColor: agentState === 'speaking' ? '#ff2a2a' : '#00f3ff'
                    }}
                >
                    <div className="text-white text-xl font-bold tracking-widest shadow-[#00f3ff]">{time.split(':')[0]}:{time.split(':')[1]}</div>
                    <div className="text-[#0088ff] text-xs">{time.split(':')[2]}</div>
                    <div className="mt-2 text-[10px]" style={{ color: agentState === 'speaking' ? '#ff2a2a' : '#00f3ff' }}>{agentState}</div>
                </div>

                <div className="absolute top-1/2 -left-20 w-[140px] h-[1px] bg-[#00f3ff]/40" />
                <div className="absolute top-1/2 -right-20 w-[140px] h-[1px] bg-[#00f3ff]/40" />
                <div className="absolute -top-20 left-1/2 w-[1px] h-[140px] bg-[#00f3ff]/40" />
                <div className="absolute -bottom-20 left-1/2 w-[1px] h-[140px] bg-[#00f3ff]/40" />
            </div>

            <div className="absolute top-8 right-8 w-[360px] flex flex-col gap-6">
                <div className="relative border-r-2 border-t-2 border-[#00f3ff] p-6 min-h-[160px] bg-[#00f3ff]/5" style={{ clipPath: 'polygon(0 0, 100% 0, 100% 100%, 15px 100%, 0 calc(100% - 15px))' }}>
                    <div className="text-[#0088ff] mb-2 font-bold tracking-widest flex items-center justify-between">
                        <span>LIVE.TRANSCRIPT // RX</span>
                        {agentState === 'speaking' && <span className="w-2 h-2 rounded-full bg-[#ff2a2a] animate-pulse shadow-[0_0_8px_#ff2a2a]" />}
                    </div>
                    <div className="text-white text-sm leading-relaxed" style={{ textShadow: '0 0 5px rgba(255,255,255,0.5)' }}>
                        {spokenText ? `> ${spokenText}` : '> AWAITING INPUT...'}
                    </div>
                </div>

                <div className="relative border-r-2 border-[#0088ff] p-4 bg-[#050914] z-10" style={{ boxShadow: 'inset -20px 0 20px -20px #0088ff' }}>
                    <div className="text-[#00f3ff] mb-2 font-bold tracking-widest">WAPP.INTAKE.CONTEXT</div>
                    <div className="text-[#0088ff]/80 text-xs leading-tight">
                        STATUS: ONLINE<br/>
                        ROUTING: ENCRYPTED<br/>
                        LAST_SYNC: {time}
                    </div>
                </div>
                
                <div className="relative flex justify-end">
                    <svg width="200" height="100" viewBox="0 0 200 100" className="opacity-50">
                        <path d="M 200 0 L 150 0 L 100 50 L 0 50" fill="none" stroke="#00f3ff" strokeWidth="2" />
                        <circle cx="100" cy="50" r="4" fill="#00f3ff" />
                        <circle cx="0" cy="50" r="2" fill="#00f3ff" />
                    </svg>
                </div>
            </div>

            <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[800px] h-[100px] border-t border-[#00f3ff]/20 bg-gradient-to-t from-[#00f3ff]/5 to-transparent flex flex-col items-center justify-end pb-2">
                <canvas ref={audioCanvasRef} width={760} height={60} className="opacity-80" />
                <div className="w-full flex justify-between px-6 text-[#0088ff] text-[10px] mt-2 tracking-widest">
                    <span>FREQ.ANALYSIS</span>
                    <span>10.02.KHZ</span>
                </div>
            </div>
        </div>
    );
}
