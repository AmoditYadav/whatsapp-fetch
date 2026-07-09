import os
import sys
import time
import json
import difflib
import subprocess
import threading
import sounddevice as sd
import soundfile as sf
import requests
from groq import Groq

# ==========================================
# CONFIGURATION
# ==========================================
DATA_FILE = os.path.join(os.path.dirname(__file__), "data", "messages.jsonl")

def find_piper():
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

def load_groq_key():
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
                pass
    return None

GROQ_API_KEY = load_groq_key()
if not GROQ_API_KEY:
    print("❌ Error: GROQ_API_KEY not found in environment or .env files.")
    sys.exit(1)

client = Groq(api_key=GROQ_API_KEY)

def send_state(state, caption=""):
    try:
        requests.post("http://localhost:3000/api/jarvis/state", json={"state": state, "caption": caption}, timeout=0.5)
    except Exception:
        pass

# ==========================================
# MESSAGE CACHE  (loaded once, tail-watched)
# ==========================================
_messages_cache: list = []
_cache_file_offset: int = 0

def _bootstrap_cache():
    """Read entire file once at startup into _messages_cache."""
    global _messages_cache, _cache_file_offset
    if not os.path.exists(DATA_FILE):
        return
    _messages_cache = []
    try:
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        _messages_cache.append(json.loads(line))
                    except Exception:
                        pass
        _cache_file_offset = os.path.getsize(DATA_FILE)
    except Exception as e:
        print(f"⚠️ Cache bootstrap error: {e}")
    print(f"[cache] Loaded {len(_messages_cache)} messages into memory.")

def _refresh_cache():
    """Append any lines written since the last refresh."""
    global _cache_file_offset
    if not os.path.exists(DATA_FILE):
        return
    try:
        current_size = os.path.getsize(DATA_FILE)
        if current_size <= _cache_file_offset:
            return
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            f.seek(_cache_file_offset)
            added = 0
            for line in f:
                line = line.strip()
                if line:
                    try:
                        _messages_cache.append(json.loads(line))
                        added += 1
                    except Exception:
                        pass
            _cache_file_offset = f.tell()
        if added:
            print(f"[cache] Appended {added} new messages (total: {len(_messages_cache)}).")
    except Exception as e:
        print(f"⚠️ Cache refresh error: {e}")

# Bootstrap the cache once at import time
_bootstrap_cache()

# ==========================================
# GROUP MANAGEMENT
# ==========================================
def get_all_groups():
    _refresh_cache()
    groups = {m["group"].strip() for m in _messages_cache if m.get("group")}
    return sorted(groups)

def fuzzy_match_group(query, available_groups):
    if not available_groups:
        return None, 0.0
    query_lower = query.lower().strip()
    groups_lower = [g.lower() for g in available_groups]
    for i, g in enumerate(groups_lower):
        if query_lower in g or g in query_lower:
            return available_groups[i], 1.0
    matches = difflib.get_close_matches(query_lower, groups_lower, n=1, cutoff=0.4)
    if matches:
        idx = groups_lower.index(matches[0])
        score = difflib.SequenceMatcher(None, query_lower, matches[0]).ratio()
        return available_groups[idx], score
    return None, 0.0

def get_whatsapp_context(group_name, limit=20):
    target = group_name.strip().lower()
    messages = [m for m in _messages_cache if m.get("group", "").strip().lower() == target]
    messages.sort(key=lambda m: m.get("timestamp", 0))
    return messages[-limit:]

# ==========================================
# LLM — Extract group & Generate Response
# ==========================================
def extract_groups_from_query(transcription, available_groups):
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
            max_tokens=50,
            timeout=15.0
        )
        raw = completion.choices[0].message.content.strip()
    except Exception as e:
        raw = ""

    resolved = []
    if raw and raw.upper() != "NONE":
        for line in raw.splitlines():
            candidate = line.strip().lstrip("- ").strip()
            if not candidate: continue
            matched, score = fuzzy_match_group(candidate, available_groups)
            if matched and matched not in [r[0] for r in resolved]:
                resolved.append((matched, get_whatsapp_context(matched)))

    if not resolved:
        words = transcription.lower().split()
        for length in range(len(words), 0, -1):
            for start in range(len(words) - length + 1):
                phrase = " ".join(words[start:start + length])
                matched, score = fuzzy_match_group(phrase, available_groups)
                if matched and score >= 0.5 and matched not in [r[0] for r in resolved]:
                    resolved.append((matched, get_whatsapp_context(matched)))
                    break
            if resolved: break
    return resolved

def generate_response(prompt, group_contexts):
    context_str = ""
    if group_contexts:
        for group_name, messages in group_contexts:
            context_str += f"\n--- Group: {group_name} ---\n"
            if messages:
                for msg in messages:
                    fallback = msg.get("author", "Unknown").split("@")[0]
                    author = msg.get("authorName", fallback)
                    body = msg.get("body", "(Media)")
                    context_str += f"[{author}] said: {body}\n"
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
        "5. If there is no new activity or the context is empty, politely let the user know.\n"
        "6. If a sender's name is just a long string of numbers (a phone number), DO NOT read the numbers. Refer to them as 'someone', 'a member', or 'a participant'."
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
            max_tokens=200,
            timeout=15.0
        )
        return completion.choices[0].message.content
    except Exception as e:
        return f"Apologies sir, I encountered an error communicating with the Groq API: {e}"

# ==========================================
# TTS — Speak via Piper
# ==========================================
def speak(text):
    import uuid
    print("🗣️  Synthesizing speech locally via Piper TTS...")
    if not os.path.exists(PIPER_PATH):
        print(f"❌ Piper binary not found at '{PIPER_PATH}'")
        return

    # Use a unique filename per synthesis to prevent Windows file-locking conflicts
    output_wav = f"output_{uuid.uuid4().hex[:8]}.wav"
    process = subprocess.Popen(
        [PIPER_PATH, "--model", PIPER_MODEL, "--output_file", output_wav, "--length_scale", "0.9"],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )
    try:
        process.communicate(input=text.encode('utf-8'), timeout=10)
    except subprocess.TimeoutExpired:
        print("❌ Piper TTS synthesis timed out (10s limit).")
        process.kill()
        process.communicate()

    if os.path.exists(output_wav):
        try:
            data, fs = sf.read(output_wav)
            sd.play(data, fs)
            sd.wait()
        except Exception as e:
            print(f"❌ Error playing audio: {e}")
        finally:
            try:
                os.remove(output_wav)
            except Exception as e:
                print(f"⚠️ Warning: Could not clean up temporary wave file '{output_wav}': {e}")
    else:
        print("❌ Piper failed to generate audio.")

# ==========================================
# MAIN LOOP
# ==========================================
def run_jarvis():
    print("📡 Connected to Dashboard. Waiting for voice commands from the UI...")
    try:
        while True:
            # Poll for commands from the frontend UI
            try:
                resp = requests.get("http://localhost:3000/api/jarvis/command", timeout=2)
                data = resp.json()
            except Exception:
                time.sleep(1)
                continue

            if not data or not data.get("command"):
                time.sleep(0.3)
                continue

            user_text = data["command"]
            print(f"\n➡️  UI Command Received: \"{user_text}\"")
            
            # Send 'processing' state — frontend mic stays off, shows spinner
            send_state("processing", f"Processing: {user_text}")

            try:
                available_groups = get_all_groups()
                group_contexts = extract_groups_from_query(user_text, available_groups)
                response_text = generate_response(user_text, group_contexts)
                print(f"🤖 Jarvis: {response_text}")
                
                # Send 'speaking' state with the caption so the frontend can display it
                send_state("speaking", response_text)
                speak(response_text)
            except Exception as e:
                err_msg = f"Apologies, sir. I encountered a technical difficulty: {e}"
                print(f"❌ Error during processing: {e}")
                send_state("speaking", err_msg)
                try:
                    speak(err_msg)
                except Exception:
                    pass
            finally:
                # ALWAYS return to idle so the browser microphone unlocks
                send_state("idle", "")

    except KeyboardInterrupt:
        print("\nFarewell, sir.")
        sys.exit(0)

if __name__ == "__main__":
    print("\n====================================================")
    print("  Jarvis — WhatsApp Voice Agent (Groq-Powered)")
    print("====================================================")
    run_jarvis()
