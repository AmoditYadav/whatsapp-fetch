import os
import sys
import time
import wave
import subprocess
import requests
import urllib.parse
import numpy as np
import sounddevice as sd
import soundfile as sf
from groq import Groq

# ==========================================
# CONFIGURATION
# ==========================================
NODE_API_URL = "http://localhost:3000/api/groups"

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
    # Check environment variable first
    key = os.environ.get("GROQ_API_KEY")
    if key:
        return key
    
    # Check in current or parent directory for a .env file
    env_paths = [".env", "../.env"]
    for path in env_paths:
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    for line in f:
                        if line.strip().startswith("GROQ_API_KEY="):
                            # Split on the first '=' and clean the value
                            val = line.split("=", 1)[1].strip()
                            return val.strip('"').strip("'")
            except Exception as e:
                print(f"⚠️  Could not read env file {path}: {e}")
    return None

GROQ_API_KEY = load_groq_key()
if not GROQ_API_KEY:
    print("❌ Error: GROQ_API_KEY not found in environment or .env files.")
    print("Please ensure your D:\\whatsapp-web.js\\.env file has a valid GROQ_API_KEY=your_key")
    sys.exit(1)

# Initialize Groq Client
client = Groq(api_key=GROQ_API_KEY)

def record_audio_keypress(filename):
    """
    Records audio from microphone.
    Press ENTER to start, press ENTER again to stop.
    Uses threading to safely read keyboard input while PortAudio is running.
    """
    import threading
    input("\n🎙️  Press [ENTER] to start recording...")
    print("🔴 Recording... Press [ENTER] again to stop.")

    stop_event = threading.Event()
    audio_chunks = []

    def audio_callback(indata, frames, time_info, status):
        if not stop_event.is_set():
            audio_chunks.append(indata.copy())

    stream = sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype='int16', callback=audio_callback)
    stream.start()

    # Wait for the user to press Enter on the MAIN thread (not inside the stream thread)
    input()
    stop_event.set()
    stream.stop()
    stream.close()

    print("🛑 Recording stopped. Saving audio...")

    if not audio_chunks:
        print("⚠️  No audio captured. Check your microphone.")
        return

    audio_np = np.concatenate(audio_chunks, axis=0)

    with wave.open(filename, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit = 2 bytes
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(audio_np.tobytes())

def transcribe_audio(filename):
    """Sends audio to Groq API for high-speed Whisper Large V3 Turbo transcription."""
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

def get_whatsapp_context(group_name):
    """Fetches the last 20 messages of the group from the Node.js API."""
    encoded_group = urllib.parse.quote(group_name)
    print(f"📥 Pulling context for group: '{group_name}' (encoded: '{encoded_group}') from dashboard...")
    try:
        url = f"{NODE_API_URL}/{encoded_group}/latest"
        response = requests.get(url, timeout=5)
        if response.status_code == 200:
            messages = response.json().get('messages', [])
            return messages
        else:
            print(f"⚠️  Dashboard returned status code {response.status_code}")
            return []
    except Exception as e:
        print(f"⚠️  Could not connect to Dashboard API: {e}")
        return []

def extract_group_name(transcription):
    """
    Heuristics to find which group the user is asking about.
    Expects queries like: 'Jarvis, pull up the latest stuff said in Design Engineering'
    """
    text = transcription.lower()
    
    # Basic triggers
    triggers = ["said in", "stuff in", "group", "about", "latest in"]
    for trigger in triggers:
        if trigger in text:
            parts = text.split(trigger)
            if len(parts) > 1:
                # Get everything after the trigger, strip punctuation
                group_candidate = parts[1].strip().replace("?", "").replace(".", "").replace("!", "")
                if group_candidate:
                    return group_candidate
                    
    # Fallback to a default if not found
    return "design engineering"

def generate_response(prompt, messages, group_name):
    """Sends the context to Groq (Llama 4 Scout) to generate a spoken Jarvis summary."""
    print("🧠 Querying Groq API (meta-llama/llama-4-scout-17b-16e-instruct) for Jarvis response...")
    
    # Format the WhatsApp logs for the LLM
    context_str = ""
    for msg in messages:
        author = msg.get('author', 'Unknown').split('@')[0]
        body = msg.get('body', '(Media)')
        context_str += f"[{author}]: {body}\n"

    system_prompt = (
        "You are Jarvis, a highly sophisticated British AI butler. "
        "Your task is to summarize the recent WhatsApp group messages provided. "
        "Follow these rules strictly:\n"
        "1. Adopt a polite, witty, British accent/tone (e.g., 'Very well, sir', 'It appears that...').\n"
        "2. Be extremely concise. Keep the summary limited to 2 or 3 short sentences.\n"
        "3. Write responses exactly as they should be spoken. Do NOT use markdown (*, #, __), bullet points, or list numbers.\n"
        "4. Spell out acronyms or abbreviations if needed, so the Text-To-Speech engine pronounces them correctly.\n"
        "5. If there is no new activity or the context is empty, politely let the user know."
    )

    user_prompt = f"The user asked: '{prompt}'.\nHere is the latest message history from the group '{group_name}':\n{context_str}"

    try:
        completion = client.chat.completions.create(
            model="meta-llama/llama-4-scout-17b-16e-instruct",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            temperature=0.7,
            max_tokens=150
        )
        return completion.choices[0].message.content
    except Exception as e:
        return f"Apologies sir, I encountered an error communicating with the Groq API: {e}"

def speak(text):
    """Sends text to Piper TTS for sub-second CPU speech synthesis, then plays it."""
    print("🗣️  Synthesizing speech locally via Piper TTS...")
    if not os.path.exists(PIPER_PATH):
        print(f"❌ Error: Piper binary not found at {PIPER_PATH}")
        # Fallback to print
        print(f"Jarvis says: {text}")
        return
        
    output_wav = "output.wav"
    
    # Run Piper TTS via subprocess pipe. Added --length_scale 0.9 to make Jarvis speak 10% faster.
    process = subprocess.Popen(
        [PIPER_PATH, "--model", PIPER_MODEL, "--output_file", output_wav, "--length_scale", "0.9"],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )
    process.communicate(input=text.encode('utf-8'))
    
    # Play generated audio
    if os.path.exists(output_wav):
        try:
            data, fs = sf.read(output_wav)
            sd.play(data, fs)
            sd.wait()
        finally:
            try:
                os.remove(output_wav) # Cleanup
            except:
                pass
    else:
        print("❌ Error: Piper failed to generate output.wav")

def run_jarvis():
    input_wav = "input.wav"
    try:
        record_audio_keypress(input_wav)

        if not os.path.exists(input_wav):
            print("⚠️  No audio file was saved. Skipping.")
            return

        user_text = transcribe_audio(input_wav)

        if not user_text:
            print("⚠️  Could not transcribe audio. Skipping.")
            return

        print(f"➡️  You said: \"{user_text}\"")

        group_name = extract_group_name(user_text)
        context = get_whatsapp_context(group_name)

        response_text = generate_response(user_text, context, group_name)
        print(f"🤖 Jarvis: {response_text}")
        speak(response_text)

    finally:
        if os.path.exists(input_wav):
            try:
                os.remove(input_wav)
            except:
                pass

if __name__ == "__main__":
    try:
        while True:
            run_jarvis()
            choice = input("\nWould you like to ask Jarvis another question? (y/n): ").lower()
            if choice != 'y':
                print("Farewell, sir.")
                break
    except KeyboardInterrupt:
        print("\nFarewell, sir.")
