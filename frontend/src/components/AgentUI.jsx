import React, { useState, useEffect, useRef, useCallback } from 'react';

// ─── Helpers ────────────────────────────────────────────────────────────────

const generateNetworkHex = () => {
    const chars = 'ABCDEF0123456789';
    return Array.from({ length: 24 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

const pad2 = (n) => String(n).padStart(2, '0');

// ─── Constants ───────────────────────────────────────────────────────────────
const STATE_COLORS = {
    idle:       { primary: '#00e5ff', glow: 'rgba(0,229,255,0.4)',  ring: '#00e5ff33' },
    processing: { primary: '#ffb300', glow: 'rgba(255,179,0,0.4)',  ring: '#ffb30033' },
    speaking:   { primary: '#e040fb', glow: 'rgba(224,64,251,0.5)', ring: '#e040fb33' },
};
const STATE_LABELS = {
    idle:       'STANDING BY',
    processing: 'PROCESSING',
    speaking:   'SPEAKING',
};

// ─── Main Component ──────────────────────────────────────────────────────────

export default function AgentUI() {
    const [agentState, setAgentState]   = useState('idle');
    const [transcript, setTranscript]   = useState('');
    const [caption, setCaption]         = useState('');
    const [isMicOn, setIsMicOn]         = useState(false);
    const [time, setTime]               = useState({ hm: '00:00', s: '00', ms: '00' });
    const [cpuVal, setCpuVal]           = useState(14);
    const [ramVal, setRamVal]           = useState(8.2);
    const [netLog, setNetLog]           = useState([]);

    // Refs — recognition engine
    const recogRef          = useRef(null);
    const micOnRef          = useRef(false);       // true = user wants mic running
    const agentStateRef     = useRef('idle');       // mirror of agentState for use inside closures
    const isCommandModeRef  = useRef(false);        // wakeword heard, collecting command
    const cmdBufferRef      = useRef('');           // confirmed final words since wakeword
    const wakeResultIdxRef  = useRef(-1);           // resultIndex where wakeword was found
    const debounceRef       = useRef(null);
    const sessionIdRef      = useRef(0);            // increments every time recognition starts

    // Refs — canvas
    const cpuCanvasRef  = useRef(null);
    const waveCanvasRef = useRef(null);
    const cpuHistory    = useRef(new Array(60).fill(14));

    // ── keep agentStateRef in sync ────────────────────────────────────────────
    useEffect(() => {
        agentStateRef.current = agentState;
    }, [agentState]);

    // ─── Reset all recognition state (call every time recognition restarts) ──
    const resetRecogState = useCallback(() => {
        isCommandModeRef.current = false;
        wakeResultIdxRef.current = -1;
        cmdBufferRef.current     = '';
        if (debounceRef.current) {
            clearTimeout(debounceRef.current);
            debounceRef.current = null;
        }
    }, []);

    // ─── Send a command to Jarvis backend ────────────────────────────────────
    const sendCommand = useCallback((cmd) => {
        if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }

        const clean = cmd.trim().replace(/^[\s,.:!?]+/, '').trim();
        if (!clean) {
            resetRecogState();
            return;
        }

        console.log('[Jarvis] Sending command:', clean);
        setTranscript(`[YOU] › ${clean.toUpperCase()}`);

        fetch('/api/jarvis/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: clean }),
        }).catch(err => console.error('[Jarvis] send error:', err));

        // Stop the mic — it will restart when backend sends 'idle'
        resetRecogState();
        if (recogRef.current) {
            try { recogRef.current.stop(); } catch (_) {}
        }
    }, [resetRecogState]);

    // ─── Speech Recognition setup (runs once) ────────────────────────────────
    useEffect(() => {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) { console.warn('[Jarvis] SpeechRecognition not available'); return; }

        const rec = new SR();
        rec.continuous      = true;
        rec.interimResults  = true;
        rec.lang            = 'en-US';
        recogRef.current    = rec;

        rec.onstart = () => {
            sessionIdRef.current += 1;   // new session → all old resultIndex values are invalid
            resetRecogState();            // clear stale wakeword / command state
            setIsMicOn(true);
        };

        rec.onerror = (ev) => {
            console.error('[Jarvis] rec error:', ev.error);
            if (ev.error === 'not-allowed' || ev.error === 'audio-capture') {
                micOnRef.current = false;
                setIsMicOn(false);
            }
        };

        rec.onend = () => {
            setIsMicOn(false);
            // Auto-restart only when: user wants mic AND agent is not busy
            if (micOnRef.current && agentStateRef.current === 'idle') {
                setTimeout(() => {
                    if (micOnRef.current && agentStateRef.current === 'idle') {
                        try { rec.start(); } catch (_) {}
                    }
                }, 350);
            }
        };

        rec.onresult = (event) => {
            if (isCommandModeRef.current && wakeResultIdxRef.current !== -1) {
                // ── Command-collection mode ──────────────────────────────────
                let finalWords    = '';
                let interimWords  = '';

                for (let i = wakeResultIdxRef.current; i < event.results.length; i++) {
                    let text = event.results[i][0].transcript;

                    // Strip "jarvis" prefix from the anchor result only
                    if (i === wakeResultIdxRef.current) {
                        const lo = text.toLowerCase();
                        const wi = lo.indexOf('jarvis');
                        if (wi !== -1) text = text.substring(wi + 6);
                    }

                    if (event.results[i].isFinal) finalWords   += text + ' ';
                    else                           interimWords += text + ' ';
                }

                cmdBufferRef.current = finalWords.trim();
                const display = (cmdBufferRef.current + ' ' + interimWords).trim().replace(/^[\s,.:!?]+/, '');
                if (display) setTranscript(`[YOU] › ${display.toUpperCase()}`);

                // Restart 1.4s silence debounce on every new speech fragment
                if (debounceRef.current) clearTimeout(debounceRef.current);
                debounceRef.current = setTimeout(() => {
                    const final = cmdBufferRef.current || interimWords.trim();
                    if (final.trim()) {
                        sendCommand(final.trim());
                    } else {
                        resetRecogState();
                        setTranscript('');
                    }
                }, 1400);

            } else {
                // ── Passive / wakeword-detection mode ───────────────────────
                let passiveText = '';
                for (let i = event.resultIndex; i < event.results.length; i++) {
                    const text = event.results[i][0].transcript;
                    const lo   = text.toLowerCase();
                    const wi   = lo.indexOf('jarvis');

                    if (wi !== -1) {
                        // Wakeword detected!
                        isCommandModeRef.current  = true;
                        wakeResultIdxRef.current  = i;
                        cmdBufferRef.current      = text.substring(wi + 6).trim();
                        const post = cmdBufferRef.current.replace(/^[\s,.:!?]+/, '').trim();
                        setTranscript(post ? `[YOU] › ${post.toUpperCase()}` : '[ LISTENING FOR COMMAND… ]');

                        if (debounceRef.current) clearTimeout(debounceRef.current);
                        debounceRef.current = setTimeout(() => {
                            const final = cmdBufferRef.current;
                            if (final.trim()) sendCommand(final.trim());
                            else { resetRecogState(); setTranscript(''); }
                        }, 1400);
                        break;
                    }

                    passiveText += text;
                }

                if (!isCommandModeRef.current && passiveText.trim()) {
                    setTranscript(`[ENV] › ${passiveText.trim().toUpperCase()}`);
                }
            }
        };

        return () => {
            rec.stop();
            resetRecogState();
        };
    }, [resetRecogState, sendCommand]);

    // ─── Agent state → mic control ────────────────────────────────────────────
    useEffect(() => {
        agentStateRef.current = agentState;

        if (agentState === 'speaking' || agentState === 'processing') {
            // Halt mic while Jarvis is busy
            if (recogRef.current) try { recogRef.current.stop(); } catch (_) {}
        } else if (agentState === 'idle' && micOnRef.current) {
            // Resume mic when Jarvis goes idle
            resetRecogState();
            setTimeout(() => {
                if (micOnRef.current && agentStateRef.current === 'idle') {
                    try { recogRef.current.start(); } catch (_) {}
                }
            }, 300);
        }
    }, [agentState, resetRecogState]);

    // ─── Toggle mic button ────────────────────────────────────────────────────
    const toggleMic = () => {
        if (!recogRef.current) { alert('Speech Recognition not supported in this browser.'); return; }
        if (micOnRef.current) {
            micOnRef.current = false;
            try { recogRef.current.stop(); } catch (_) {}
            setIsMicOn(false);
        } else {
            micOnRef.current = true;
            resetRecogState();
            try { recogRef.current.start(); } catch (_) {}
        }
    };

    // ─── SSE — receive state + caption from Jarvis backend ───────────────────
    useEffect(() => {
        let es;
        const connect = () => {
            es = new EventSource(`${window.location.origin}/api/jarvis/stream`);
            es.onmessage = (ev) => {
                try {
                    const d = JSON.parse(ev.data);
                    if (d.state) setAgentState(d.state);
                    // caption can be empty string (to clear) — use !== undefined
                    if (d.caption !== undefined) setCaption(d.caption);
                } catch (_) {}
            };
            es.onerror = () => { es.close(); setTimeout(connect, 3000); };
        };
        connect();
        return () => es && es.close();
    }, []);

    // ─── Clock + fake metrics ─────────────────────────────────────────────────
    useEffect(() => {
        const id = setInterval(() => {
            const now = new Date();
            setTime({
                hm: `${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
                s:  pad2(now.getSeconds()),
                ms: pad2(Math.floor(now.getMilliseconds() / 10)),
            });
            setCpuVal(prev => {
                const v = Math.max(2, Math.min(98, prev + (Math.random() * 16 - 8)));
                cpuHistory.current.push(v);
                if (cpuHistory.current.length > 60) cpuHistory.current.shift();
                return v;
            });
            setRamVal(prev => Math.max(5.5, Math.min(14.5, prev + (Math.random() * 0.3 - 0.15))));
            setNetLog(prev => {
                const next = [...prev, `0x${generateNetworkHex()} ✓`];
                return next.length > 12 ? next.slice(-12) : next;
            });
        }, 120);
        return () => clearInterval(id);
    }, []);

    // ─── CPU canvas ───────────────────────────────────────────────────────────
    useEffect(() => {
        const c = cpuCanvasRef.current; if (!c) return;
        const ctx = c.getContext('2d');
        const w = c.width, h = c.height;
        ctx.clearRect(0, 0, w, h);
        const step = w / (cpuHistory.current.length - 1);
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0,   'rgba(0,229,255,0.9)');
        grad.addColorStop(1,   'rgba(0,229,255,0.05)');
        ctx.strokeStyle = '#00e5ff';
        ctx.lineWidth   = 2;
        ctx.shadowBlur  = 8;
        ctx.shadowColor = '#00e5ff';
        ctx.beginPath();
        cpuHistory.current.forEach((v, i) => {
            const x = i * step, y = h - (v / 100) * h;
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.shadowBlur = 0;
        // fill below
        ctx.lineTo(w, h); ctx.lineTo(0, h);
        ctx.fillStyle = grad;
        ctx.fill();
    }, [cpuVal]);

    // ─── Waveform canvas ──────────────────────────────────────────────────────
    useEffect(() => {
        const c = waveCanvasRef.current; if (!c) return;
        const ctx = c.getContext('2d');
        let raf;
        const col = STATE_COLORS[agentState] || STATE_COLORS.idle;
        const draw = () => {
            const w = c.width, h = c.height;
            ctx.clearRect(0, 0, w, h);
            const bars = 80;
            const bw   = w / bars - 1;
            for (let i = 0; i < bars; i++) {
                let amp;
                if (agentState === 'speaking') {
                    amp = (Math.random() * 0.7 + 0.3) * h;
                } else if (agentState === 'processing') {
                    const phase = (Date.now() / 200 + i * 0.3) % (Math.PI * 2);
                    amp = (Math.sin(phase) * 0.3 + 0.35) * h;
                } else {
                    amp = (Math.random() * 0.08 + 0.04) * h;
                }
                const x = i * (bw + 1);
                const y = (h - amp) / 2;
                ctx.fillStyle   = col.primary;
                ctx.shadowBlur  = agentState !== 'idle' ? 12 : 4;
                ctx.shadowColor = col.primary;
                ctx.fillRect(x, y, bw, amp);
            }
            raf = requestAnimationFrame(draw);
        };
        draw();
        return () => cancelAnimationFrame(raf);
    }, [agentState]);

    // ─── Derived display values ────────────────────────────────────────────────
    const col       = STATE_COLORS[agentState] || STATE_COLORS.idle;
    const stateLabel = STATE_LABELS[agentState] || agentState.toUpperCase();
    const displayText = caption || transcript || '> AWAITING COMMAND — SAY "JARVIS …"';

    const ringStyle = (size, dur, rev, col, dash) => ({
        position: 'absolute',
        width: size, height: size,
        borderRadius: '50%',
        border: `2px ${dash ? 'dashed' : 'solid'} ${col}`,
        animation: `${rev ? 'spin-ccw' : 'spin-cw'} ${dur}s linear infinite`,
        boxShadow: `0 0 8px ${col}`,
    });

    return (
        <div
            id="jarvis-root"
            style={{
                position: 'fixed', inset: 0,
                background: 'radial-gradient(ellipse at 50% 30%, #06101f 0%, #020810 70%)',
                fontFamily: "'Share Tech Mono', 'Courier New', monospace",
                color: col.primary,
                overflow: 'hidden',
                userSelect: 'none',
                fontSize: 12,
                letterSpacing: '0.08em',
            }}
        >
            {/* Google Fonts */}
            <link rel="preconnect" href="https://fonts.googleapis.com" />
            <link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap" rel="stylesheet" />

            <style>{`
                @keyframes spin-cw  { from { transform: rotate(0deg); }   to { transform: rotate(360deg); } }
                @keyframes spin-ccw { from { transform: rotate(360deg); } to { transform: rotate(0deg); } }
                @keyframes pulse-ring {
                    0%,100% { opacity: 0.6; transform: scale(1); }
                    50%     { opacity: 1;   transform: scale(1.04); }
                }
                @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.3} }
                @keyframes slide-up {
                    from { opacity:0; transform: translateY(8px); }
                    to   { opacity:1; transform: translateY(0); }
                }
                ::-webkit-scrollbar { display:none; }
                .panel {
                    background: rgba(255,255,255,0.03);
                    border: 1px solid rgba(255,255,255,0.08);
                    border-radius: 4px;
                    backdrop-filter: blur(8px);
                    padding: 14px 16px;
                }
                .panel-title {
                    font-size: 10px;
                    letter-spacing: 0.2em;
                    opacity: 0.5;
                    margin-bottom: 10px;
                    text-transform: uppercase;
                }
                .accent-bar {
                    display: inline-block;
                    width: 2px; height: 10px;
                    background: currentColor;
                    margin-right: 6px;
                    vertical-align: middle;
                }
                .mic-btn {
                    cursor: pointer;
                    border-radius: 4px;
                    padding: 12px 18px;
                    font-family: inherit;
                    font-size: 11px;
                    letter-spacing: 0.18em;
                    text-transform: uppercase;
                    transition: all 0.25s ease;
                    width: 100%;
                }
                .mic-btn:hover { filter: brightness(1.25); }
                .net-line { animation: slide-up 0.3s ease both; }
            `}</style>

            {/* ── LEFT PANEL ─────────────────────────────────────────────── */}
            <div style={{ position:'absolute', top:24, left:24, width:260, display:'flex', flexDirection:'column', gap:14 }}>

                {/* CPU */}
                <div className="panel">
                    <div className="panel-title" style={{ color: col.primary }}>
                        <span className="accent-bar" />SYS · CPU MATRIX
                    </div>
                    <div style={{ display:'flex', justifyContent:'space-between', marginBottom:6 }}>
                        <span style={{ color:'#fff', fontSize:11, fontWeight:'bold' }}>{cpuVal.toFixed(1)}%</span>
                        <span style={{ opacity:0.4, fontSize:10 }}>LOAD AVG</span>
                    </div>
                    <canvas ref={cpuCanvasRef} width={228} height={72} style={{ width:'100%', height:72, display:'block' }} />
                </div>

                {/* RAM */}
                <div className="panel">
                    <div className="panel-title" style={{ color: col.primary }}>
                        <span className="accent-bar" />MEM · HEAP ALLOC
                    </div>
                    <div style={{ display:'flex', justifyContent:'space-between', marginBottom:8 }}>
                        <span style={{ color:'#fff', fontSize:11 }}>{ramVal.toFixed(1)} / 16.0 GB</span>
                        <span style={{ opacity:0.4, fontSize:10 }}>{((ramVal/16)*100).toFixed(0)}%</span>
                    </div>
                    <div style={{ display:'flex', gap:2, height:8 }}>
                        {Array.from({length: 24}).map((_, i) => (
                            <div key={i} style={{
                                flex:1, borderRadius:1,
                                background: i < (ramVal/16)*24 ? col.primary : 'rgba(255,255,255,0.07)',
                                boxShadow: i < (ramVal/16)*24 ? `0 0 4px ${col.primary}` : 'none',
                                transition: 'background 0.3s',
                            }} />
                        ))}
                    </div>
                </div>

                {/* Network log */}
                <div className="panel" style={{ maxHeight:190, overflow:'hidden' }}>
                    <div className="panel-title" style={{ color: col.primary }}>
                        <span className="accent-bar" />NET · UPLINK STREAM
                    </div>
                    <div style={{ display:'flex', flexDirection:'column', gap:2, fontSize:9, opacity:0.55, fontFamily:'monospace' }}>
                        {netLog.map((l, i) => (
                            <div key={i} className="net-line">{l}</div>
                        ))}
                    </div>
                </div>

                {/* WhatsApp status */}
                <div className="panel">
                    <div className="panel-title" style={{ color: col.primary }}>
                        <span className="accent-bar" />WAPP · INTAKE STATUS
                    </div>
                    <div style={{ fontSize:10, opacity:0.6, lineHeight:1.8 }}>
                        STATUS &nbsp;&nbsp;&nbsp; <span style={{ color:'#69ff85' }}>ONLINE</span><br/>
                        ROUTING &nbsp; <span>ENCRYPTED</span><br/>
                        SYNC &nbsp;&nbsp;&nbsp;&nbsp; {time.hm}:{time.s}
                    </div>
                </div>
            </div>

            {/* ── CENTRE ORB ─────────────────────────────────────────────── */}
            <div style={{
                position:'absolute', top:'50%', left:'50%',
                transform:'translate(-50%,-50%)',
                width:520, height:520,
                display:'flex', alignItems:'center', justifyContent:'center',
            }}>
                {/* Rings */}
                <div style={ringStyle('480px', 40, false, `${col.primary}18`, true)} />
                <div style={ringStyle('420px', 28, true,  `${col.primary}28`, false)} />
                <div style={ringStyle('360px', 18, false, `${col.primary}44`, true)} />
                <div style={{
                    ...ringStyle('300px', 12, true,  col.primary, false),
                    borderWidth: 2,
                    animation: `spin-ccw 12s linear infinite, pulse-ring ${agentState === 'speaking' ? '0.35s' : '3s'} ease-in-out infinite`,
                }} />
                <div style={ringStyle('220px', 8, false, col.primary, false)} />

                {/* Core orb */}
                <div style={{
                    position:'absolute',
                    width:130, height:130,
                    borderRadius:'50%',
                    background: `radial-gradient(circle at 38% 38%, ${col.primary}22 0%, #020810 70%)`,
                    border: `2px solid ${col.primary}`,
                    boxShadow: `0 0 40px ${col.glow}, inset 0 0 20px ${col.glow}`,
                    display:'flex', flexDirection:'column',
                    alignItems:'center', justifyContent:'center',
                    zIndex:10,
                    transition: 'box-shadow 0.5s, border-color 0.5s',
                }}>
                    <div style={{ fontSize:26, fontWeight:'bold', color:'#fff', letterSpacing:2, lineHeight:1 }}>
                        {time.hm}
                    </div>
                    <div style={{ fontSize:13, color: col.primary, opacity:0.8, marginTop:2 }}>
                        {time.s}<span style={{ opacity:0.5 }}>.{time.ms}</span>
                    </div>
                    <div style={{
                        marginTop:8, fontSize:9, letterSpacing:4,
                        color: col.primary,
                        animation: agentState !== 'idle' ? 'blink 1s ease infinite' : 'none',
                    }}>
                        {stateLabel}
                    </div>
                </div>

                {/* Cross-hairs */}
                {[
                    { top:'50%', left:'-8%', width:'16%', height:1 },
                    { top:'50%', right:'-8%', width:'16%', height:1 },
                    { left:'50%', top:'-8%', height:'16%', width:1 },
                    { left:'50%', bottom:'-8%', height:'16%', width:1 },
                ].map((s, i) => (
                    <div key={i} style={{ position:'absolute', background:`${col.primary}55`, ...s }} />
                ))}
            </div>

            {/* ── RIGHT PANEL ────────────────────────────────────────────── */}
            <div style={{ position:'absolute', top:24, right:24, width:290, display:'flex', flexDirection:'column', gap:14 }}>

                {/* Mic toggle */}
                <button
                    id="mic-toggle-btn"
                    className="mic-btn"
                    onClick={toggleMic}
                    style={{
                        background: isMicOn ? `${col.primary}18` : 'rgba(255,255,255,0.04)',
                        border: `1.5px solid ${isMicOn ? col.primary : 'rgba(255,255,255,0.12)'}`,
                        color: isMicOn ? col.primary : 'rgba(255,255,255,0.4)',
                        boxShadow: isMicOn ? `0 0 20px ${col.glow}` : 'none',
                    }}
                >
                    <span style={{ marginRight:8, animation: isMicOn ? 'blink 1s infinite' : 'none' }}>●</span>
                    {isMicOn ? 'MIC ACTIVE — WAKEWORD: "JARVIS"' : 'MIC OFFLINE — CLICK TO ACTIVATE'}
                </button>

                {/* Transcript */}
                <div className="panel" style={{ minHeight:160 }}>
                    <div className="panel-title" style={{ color: col.primary, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                        <span><span className="accent-bar" />LIVE TRANSCRIPT · RX</span>
                        {isMicOn && <span style={{ width:6, height:6, borderRadius:'50%', background:'#ff4444', boxShadow:'0 0 8px #ff4444', display:'inline-block', animation:'blink 0.8s infinite' }} />}
                    </div>
                    <div style={{
                        color:'#fff',
                        fontSize: caption ? 12 : 11,
                        lineHeight: 1.65,
                        textShadow: `0 0 12px ${col.glow}`,
                        wordBreak: 'break-word',
                        transition: 'color 0.3s',
                    }}>
                        {displayText}
                    </div>
                </div>

                {/* Audio visualiser */}
                <div className="panel" style={{ padding:'14px 16px 10px' }}>
                    <div className="panel-title" style={{ color: col.primary }}>
                        <span className="accent-bar" />FREQ · AUDIO ANALYSIS
                    </div>
                    <canvas ref={waveCanvasRef} width={258} height={56} style={{ width:'100%', height:56, display:'block' }} />
                    <div style={{ display:'flex', justifyContent:'space-between', marginTop:6, fontSize:9, opacity:0.4 }}>
                        <span>20 Hz</span><span>1 kHz</span><span>16 kHz</span>
                    </div>
                </div>

                {/* Agent state indicator */}
                <div className="panel">
                    <div className="panel-title" style={{ color: col.primary }}>
                        <span className="accent-bar" />JARVIS · AGENT STATE
                    </div>
                    <div style={{ display:'flex', gap:8 }}>
                        {['idle','processing','speaking'].map(s => (
                            <div key={s} style={{
                                flex:1, textAlign:'center', padding:'6px 4px',
                                borderRadius:3,
                                border: `1px solid ${agentState === s ? STATE_COLORS[s].primary : 'rgba(255,255,255,0.07)'}`,
                                background: agentState === s ? `${STATE_COLORS[s].primary}18` : 'transparent',
                                fontSize:9, letterSpacing:'0.12em',
                                color: agentState === s ? STATE_COLORS[s].primary : 'rgba(255,255,255,0.3)',
                                transition: 'all 0.3s',
                                boxShadow: agentState === s ? `0 0 10px ${STATE_COLORS[s].glow}` : 'none',
                            }}>
                                {STATE_LABELS[s]}
                            </div>
                        ))}
                    </div>
                </div>

                {/* Wakeword hint */}
                <div style={{ textAlign:'center', fontSize:9, opacity:0.28, letterSpacing:'0.15em', lineHeight:1.6 }}>
                    SAY <span style={{ color: col.primary, opacity:1 }}>"JARVIS, WHAT'S HAPPENING IN [GROUP]?"</span><br/>
                    TO QUERY YOUR WHATSAPP GROUPS
                </div>
            </div>

            {/* ── BOTTOM WAVEFORM BAR ────────────────────────────────────── */}
            <div style={{
                position:'absolute', bottom:0, left:0, right:0, height:80,
                background:'linear-gradient(to top, rgba(0,229,255,0.05) 0%, transparent 100%)',
                borderTop:`1px solid ${col.primary}22`,
                display:'flex', flexDirection:'column',
                alignItems:'center', justifyContent:'flex-end',
                paddingBottom:10,
                transition:'border-color 0.5s',
            }}>
                <div style={{ width:'65%', display:'flex', justifyContent:'space-between', fontSize:9, opacity:0.3, letterSpacing:'0.18em', marginBottom:4 }}>
                    <span>JARVIS — WAPP VOICE AGENT</span>
                    <span>v2.0 · GROQ-POWERED</span>
                </div>
            </div>
        </div>
    );
}
