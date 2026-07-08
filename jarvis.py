import os
import sys
import time
import wave
import json
import difflib
import subprocess
import threading
import numpy as np
import sounddevice as sd
import soundfile as sf
from groq import Groq

# ==========================================
# CONFIGURATION
# ==========================================
DATA_FILE = os.path.join(os.path.dirname(__file__), "data", "messages.jsonl")

def find_piper():
    """Checks common directories for the piper binary."""
    candidates = [
        "piper.exe",
        "piper/piper.exe",
        "piper_windows_amd64/piper/piper.exe",
        "../piper.exe",
        "piper"
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return "piper.exe"

def find_piper_model():
    """Checks common directories for the en_US-lessac-medium.onnx model."""
    candidates = [
        "en_US-lessac-medium.onnx",
        "piper/en_US-lessac-medium.onnx",
        "piper_windows_amd64/piper/en_US-lessac-medium.onnx",
        "../en_US-lessac-medium.onnx"
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return "en_US-lessac-medium.onnx"

PIPER_PATH = find_piper()
PIPER_MODEL = find_piper_model()
SAMPLE_RATE = 16000  # Whisper API expects 16000Hz mono

def load_groq_key():
    """Loads Groq API key from environment or .env files."""
    key = os.environ.get("GROQ_API_KEY")
    if key:
        return key
    env_paths = [".env", "../.env"]
    for path in env_paths:
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    for line in f:
                        if line.strip().startswith("GROQ_API_KEY="):
                            val = line.split("=", 1)[1].strip()
                            return val.strip('"').strip("'")
            except Exception as e:
                print(f"⚠️  Could not read env file {path}: {e}")
    return None

GROQ_API_KEY = load_groq_key()
if not GROQ_API_KEY:
    print("❌ Error: GROQ_API_KEY not found in environment or .env files.")
    print("   Please add GROQ_API_KEY=your_key to D:\\whatsapp-web.js\\.env")
    sys.exit(1)

client = Groq(api_key=GROQ_API_KEY)

def send_state(state, caption=""):
    """Sends the current agent state and caption to the Node dashboard server."""
    try:
        requests.post("http://localhost:3000/api/jarvis/state", json={"state": state, "caption": caption}, timeout=0.5)
    except Exception:
        pass

# ==========================================
# GROUP MANAGEMENT — reads directly from file
# ==========================================
def get_all_groups():
    """Reads the messages file and returns a list of all unique group names."""
    groups = set()
    if not os.path.exists(DATA_FILE):
        return []
    try:
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        msg = json.loads(line)
                        if msg.get("group"):
                            groups.add(msg["group"].strip())
                    except json.JSONDecodeError:
                        pass
    except Exception as e:
        print(f"⚠️  Could not read messages file: {e}")
    return sorted(groups)

def fuzzy_match_group(query, available_groups):
    """
    Finds the best matching group name for a partial or misspelled query.
    E.g., 'the brother' → 'The Brotherhood'
    Returns (matched_name, confidence) or (None, 0) if nothing found.
    """
    if not available_groups:
        return None, 0.0

    query_lower = query.lower().strip()
    groups_lower = [g.lower() for g in available_groups]

    # Try exact substring match first (fastest and most reliable)
    for i, g in enumerate(groups_lower):
        if query_lower in g or g in query_lower:
            return available_groups[i], 1.0

    # Fall back to fuzzy sequence matching
    matches = difflib.get_close_matches(query_lower, groups_lower, n=1, cutoff=0.4)
    if matches:
        idx = groups_lower.index(matches[0])
        score = difflib.SequenceMatcher(None, query_lower, matches[0]).ratio()
        return available_groups[idx], score

    return None, 0.0

def get_whatsapp_context(group_name, limit=20):
    """
    Reads messages directly from messages.jsonl for the given group.
    No HTTP server needed.
    """
    if not os.path.exists(DATA_FILE):
        print(f"⚠️  Data file not found at '{DATA_FILE}'. Is the exporter running?")
        return []
    messages = []
    try:
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        msg = json.loads(line)
                        if msg.get("group", "").strip().lower() == group_name.strip().lower():
                            messages.append(msg)
                    except json.JSONDecodeError:
                        pass
    except Exception as e:
        print(f"⚠️  Error reading data file: {e}")
        return []

    # Sort by timestamp, newest last, return last N messages
    messages.sort(key=lambda m: m.get("timestamp", 0))
    return messages[-limit:]

# ==========================================
# LLM — Extract group name(s) from user query
# ==========================================
def extract_groups_from_query(transcription, available_groups):
    """
    Uses the Groq LLM to extract group name(s) mentioned in the user query,
    then fuzzy-matches each one against available groups.
    Returns a list of matched (real_name, context_messages) tuples.
    """
    groups_list = "\n".join(f"- {g}" for g in available_groups)
    if not groups_list:
        groups_list = "(no groups loaded yet)"

    extraction_prompt = (
        f"You are a group name extractor. Given a user query, identify which WhatsApp group(s) they are asking about.\n\n"
        f"Available groups:\n{groups_list}\n\n"
        f"User query: \"{transcription}\"\n\n"
        f"Return ONLY the group name(s) the user mentioned, one per line, exactly as they appear in the available groups list. "
        f"If the user used a partial or approximate name, match it to the closest group. "
        f"If no group is mentioned, return the word NONE."
    )

    try:
        completion = client.chat.completions.create(
            model="meta-llama/llama-4-scout-17b-16e-instruct",
            messages=[{"role": "user", "content": extraction_prompt}],
            temperature=0.0,
            max_tokens=50
        )
        raw = completion.choices[0].message.content.strip()
    except Exception as e:
        print(f"⚠️  Group extraction failed: {e}. Falling back to fuzzy match.")
        raw = ""

    # Parse lines from LLM response
    resolved = []
    if raw and raw.upper() != "NONE":
        for line in raw.splitlines():
            candidate = line.strip().lstrip("- ").strip()
            if not candidate:
                continue
            matched, score = fuzzy_match_group(candidate, available_groups)
            if matched and matched not in [r[0] for r in resolved]:
                print(f"📌 Matched group: '{candidate}' → '{matched}' (confidence: {score:.0%})")
                resolved.append((matched, get_whatsapp_context(matched)))

    # If LLM returned nothing, do a direct fuzzy match on the full transcription
    if not resolved:
        # Try to match any word sequence from the query against known groups
        words = transcription.lower().split()
        for length in range(len(words), 0, -1):
            for start in range(len(words) - length + 1):
                phrase = " ".join(words[start:start + length])
                matched, score = fuzzy_match_group(phrase, available_groups)
                if matched and score >= 0.5 and matched not in [r[0] for r in resolved]:
                    print(f"📌 Fuzzy matched: '{phrase}' → '{matched}' (confidence: {score:.0%})")
                    resolved.append((matched, get_whatsapp_context(matched)))
                    break
            if resolved:
                break

    return resolved

# ==========================================
# LLM — Generate Jarvis response
# ==========================================
def generate_response(prompt, group_contexts):
    """
    Sends multi-group context to Groq Llama 4 Scout and returns a Jarvis summary.
    group_contexts: list of (group_name, messages) tuples
    """
    print("🧠 Querying Groq API (meta-llama/llama-4-scout-17b-16e-instruct) for Jarvis response...")

    context_str = ""
    if group_contexts:
        for group_name, messages in group_contexts:
            context_str += f"\n--- Group: {group_name} ---\n"
            if messages:
                for msg in messages:
                    author = msg.get("author", "Unknown").split("@")[0]
                    body = msg.get("body", "(Media)")
                    context_str += f"[{author}]: {body}\n"
            else:
                context_str += "(No messages found for this group)\n"
    else:
        context_str = "(Could not find any matching group — no context available)"

    system_prompt = (
        "You are Jarvis, a highly sophisticated British AI butler. "
        "Your task is to summarize the recent WhatsApp group messages provided. "
        "Follow these rules strictly:\n"
        "1. Adopt a polite, witty, British accent/tone (e.g., 'Very well, sir', 'It appears that...').\n"
        "2. Be extremely concise. Keep the summary limited to 2 or 3 short sentences per group.\n"
        "3. Write responses exactly as they should be spoken aloud. Do NOT use markdown, bullet points, or list numbers.\n"
        "4. Spell out acronyms so the Text-To-Speech engine pronounces them correctly.\n"
        "5. If there is no new activity or the context is empty, politely let the user know."
    )

    user_prompt = f"The user asked: '{prompt}'.\n\nHere is the latest WhatsApp message context:\n{context_str}"

    try:
        completion = client.chat.completions.create(
            model="meta-llama/llama-4-scout-17b-16e-instruct",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            temperature=0.7,
            max_tokens=200
        )
        return completion.choices[0].message.content
    except Exception as e:
        return f"Apologies sir, I encountered an error communicating with the Groq API: {e}"

# ==========================================
# AUDIO — Record & Transcribe
# ==========================================
def record_audio_keypress(filename):
    """Records audio. Press ENTER to start, ENTER again to stop."""
    input("\n🎙️  Press [ENTER] to start recording...")
    send_state("listening")
    print("🔴 Recording... Press [ENTER] again to stop.")

    stop_event = threading.Event()
    audio_chunks = []

    def audio_callback(indata, frames, time_info, status):
        if not stop_event.is_set():
            audio_chunks.append(indata.copy())

    stream = sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype='int16', callback=audio_callback)
    stream.start()
    input()
    stop_event.set()
    stream.stop()
    stream.close()
    
    send_state("idle")
    print("🛑 Recording stopped. Saving audio...")

    if not audio_chunks:
        print("⚠️  No audio captured. Check your microphone.")
        return

    audio_np = np.concatenate(audio_chunks, axis=0)
    with wave.open(filename, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(audio_np.tobytes())

def transcribe_audio(filename):
    """Sends audio to Groq API (whisper-large-v3-turbo) for transcription."""
    print("⏳ Transcribing audio via Groq API (whisper-large-v3-turbo)...")
    try:
        with open(filename, "rb") as file:
            transcription = client.audio.transcriptions.create(
                model="whisper-large-v3-turbo",
                file=file
            )
        return transcription.text.strip() or None
    except Exception as e:
        print(f"❌ Error during Groq transcription: {e}")
        return None

# ==========================================
# TTS — Speak via Piper
# ==========================================
def speak(text):
    """Synthesizes speech locally via Piper TTS and plays it."""
    print("🗣️  Synthesizing speech locally via Piper TTS...")
    if not os.path.exists(PIPER_PATH):
        print(f"❌ Piper binary not found at '{PIPER_PATH}'")
        print(f"Jarvis says: {text}")
        return

    output_wav = "output.wav"
    process = subprocess.Popen(
        [PIPER_PATH, "--model", PIPER_MODEL, "--output_file", output_wav, "--length_scale", "0.9"],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )
    process.communicate(input=text.encode('utf-8'))

    if os.path.exists(output_wav):
        try:
            data, fs = sf.read(output_wav)
            sd.play(data, fs)
            sd.wait()
        finally:
            try:
                os.remove(output_wav)
            except:
                pass
    else:
        print("❌ Piper failed to generate audio. Check your model path.")

# ==========================================
# MAIN LOOP
# ==========================================
def run_jarvis():
    input_wav = "input.wav"
    try:
        # Show available groups at the start of each turn
        available_groups = get_all_groups()
        if available_groups:
            print(f"\n📋 Known groups: {', '.join(available_groups)}")
        else:
            print("\n⚠️  No groups loaded yet. Make sure export.js is running and has fetched messages.")

        record_audio_keypress(input_wav)

        if not os.path.exists(input_wav):
            print("⚠️  No audio file was saved. Skipping.")
            return

        user_text = transcribe_audio(input_wav)

        if not user_text:
            print("⚠️  Could not transcribe audio. Skipping.")
            return

        print(f"➡️  You said: \"{user_text}\"")

        # Resolve group(s) from the query using LLM + fuzzy matching
        group_contexts = extract_groups_from_query(user_text, available_groups)

        if not group_contexts:
            print("⚠️  Could not identify any group from your query.")

        response_text = generate_response(user_text, group_contexts)
        print(f"🤖 Jarvis: {response_text}")
        
        # Trigger WebGL visualizer state to speaking with active speech text, then reset to idle
        send_state("speaking", response_text)
        speak(response_text)
        send_state("idle")

    finally:
        if os.path.exists(input_wav):
            try:
                os.remove(input_wav)
            except:
                pass

if __name__ == "__main__":
    print("\n====================================================")
    print("  Jarvis — WhatsApp Voice Agent (Groq-Powered)")
    print("====================================================")
    try:
        while True:
            run_jarvis()
            choice = input("\nAnother question? (y/n): ").strip().lower()
            if choice != 'y':
                print("Farewell, sir.")
                break
    except KeyboardInterrupt:
        print("\nFarewell, sir.")
