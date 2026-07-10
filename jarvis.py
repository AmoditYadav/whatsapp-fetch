import os
import sys
import time
import json
import difflib
import subprocess
import sounddevice as sd
import soundfile as sf
import requests
from groq import Groq
import re

try:
    import gmail_helper
    from gmail_helper import GmailAuthError, GmailAPIError
    GMAIL_AVAILABLE = True
except ImportError:
    gmail_helper = None
    GmailAuthError = Exception
    GmailAPIError = Exception
    GMAIL_AVAILABLE = False

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
            except Exception:
                pass
    return None

GROQ_API_KEY = load_groq_key()
if not GROQ_API_KEY:
    print("❌ Error: GROQ_API_KEY not found in environment or .env files.")
    sys.exit(1)

client = Groq(api_key=GROQ_API_KEY)

def send_state(state, caption=""):
    try:
        requests.post(
            "http://localhost:3000/api/jarvis/state",
            json={"state": state, "caption": caption},
            timeout=0.5
        )
    except Exception:
        pass

# ==========================================
# WHATSAPP MESSAGE CACHE (loaded once, tail-watched)
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

# Bootstrap the cache once at startup
_bootstrap_cache()

# ==========================================
# WHATSAPP GROUP MANAGEMENT
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
# LLM — WhatsApp: Extract group & fetch context
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
    except Exception:
        raw = ""

    resolved = []
    if raw and raw.upper() != "NONE":
        for line in raw.splitlines():
            candidate = line.strip().lstrip("- ").strip()
            if not candidate:
                continue
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
            if resolved:
                break
    return resolved

# ==========================================
# CONVERSATIONAL MEMORY
# ==========================================
conversation_history = []
MAX_HISTORY_TURNS = 10  # Maximum number of (user+assistant) message pairs kept

# Tracks the last fetched emails so the user can reference them in follow-ups
# e.g. "reply to the first one"
_last_email_context: list = []
# Tracks which email the user is currently composing a reply to (message ID)
_pending_reply_to_id: str | None = None


def _trim_history():
    """Keep conversation_history within MAX_HISTORY_TURNS messages."""
    global conversation_history
    # Each turn = 2 messages (user + assistant), so cap at 2 * MAX_HISTORY_TURNS
    max_messages = MAX_HISTORY_TURNS * 2
    if len(conversation_history) > max_messages:
        conversation_history = conversation_history[-max_messages:]


# ==========================================
# INTENT CLASSIFIER & HEURISTICS
# ==========================================
def classify_intent(query: str) -> str:
    """
    Classifies a user query into one of three routing intents:
      - GMAIL_ACTION   : email-related request (read inbox / draft / reply)
      - FETCH_WHATSAPP : WhatsApp group message lookup
      - CASUAL_CHAT    : general conversation, Q&A, small talk

    Strategy:
    1. Gmail keywords — checked first (highest priority), with word-boundary matching
       to avoid false positives like "female" containing "mail".
    2. WhatsApp-specific nouns/phrases — checked second. Broad generic verbs
       (read, check, get, show) are intentionally EXCLUDED to prevent hijacking
       casual queries like "what's the latest news?" or "get me a joke".
    3. Casual chat keywords — checked third using word-boundary regex.
    4. LLM fallback — fast, low-token preliminary call for ambiguous cases.
    """
    query_lower = query.lower().strip()

    # ---- 1. Gmail triggers (word-boundary matched) ----
    gmail_triggers = [
        "email", "emails", "gmail", "mailbox",
        "draft", "drafts", "reply to", "write an email",
        "send an email", "compose an email",
        "what's in my inbox", "whats in my inbox",
        "check my inbox", "inbox",
        "did anyone email", "did someone email",
        "important in my inbox", "unread emails",
        "respond to", "write back",
    ]
    for trigger in gmail_triggers:
        pattern = r'\b' + re.escape(trigger) + r'\b'
        if re.search(pattern, query_lower):
            print(f"[classifier] Heuristic match: GMAIL_ACTION ('{trigger}')")
            return "GMAIL_ACTION"

    # ---- 2. WhatsApp-specific fetch triggers ----
    # Only use noun-level and phrase-level triggers; avoid generic verbs.
    fetch_triggers = [
        "whatsapp", "wa group",
        "chats", "chat",
        "messages", "message",
        "texts", "dm", "dms",
        "thread",
        # action phrases that only make sense for WhatsApp
        "what did they say",
        "what was said",
        "any updates from",
        "any messages from",
        "what's going on in",
        "whats going on in",
        "whats happening in",
        "what's happening in",
        "catch me up on",
        "bring me up to speed",
        "anything new in",
        "did anyone text",
        "did someone message",
        "who texted",
        "who messaged",
    ]
    for trigger in fetch_triggers:
        pattern = r'\b' + re.escape(trigger) + r'\b'
        if re.search(pattern, query_lower):
            print(f"[classifier] Heuristic match: FETCH_WHATSAPP ('{trigger}')")
            return "FETCH_WHATSAPP"

    # ---- 3. Casual chat triggers (word-boundary matched) ----
    casual_triggers = [
        # Greetings & Farewells
        "hello", "hi", "hey", "good morning", "good afternoon", "good evening",
        "morning", "evening", "what's up", "whats up", "yo", "goodbye", "bye",
        "see ya", "later", "night", "goodnight",
        # Small Talk
        "how are you", "how have you been", "what are you doing", "what are you up to",
        "hows it going", "how's it going", "who are you", "what are you",
        # Environment & Time
        "weather", "temperature", "what time is it", "what day is it",
        "raining", "sunny",
        # General Knowledge
        "tell me", "what is", "who is", "where is", "when is",
        "can you explain", "define", "calculate", "joke", "funny",
        "news", "headline", "story", "how to",
        # Affirmations & Closers
        "yes", "no", "yeah", "nope", "okay", "ok", "sure", "fine", "thanks",
        "thank you", "appreciate it", "cool", "awesome", "great",
    ]
    for trigger in casual_triggers:
        pattern = r'\b' + re.escape(trigger) + r'\b'
        if re.search(pattern, query_lower):
            print(f"[classifier] Heuristic match: CASUAL_CHAT ('{trigger}')")
            return "CASUAL_CHAT"

    # ---- 4. LLM fallback ----
    print("[classifier] Ambiguous query — running fast LLM classification call...")
    classification_prompt = (
        "You are a highly accurate intent classifier for Jarvis, a personal AI assistant.\n"
        "Classify the user's input into ONE of these three categories:\n"
        "- GMAIL_ACTION   : reading inbox, unread emails, triaging emails, drafting or replying to an email.\n"
        "- FETCH_WHATSAPP : reading, checking, or summarizing WhatsApp group or person messages.\n"
        "- CASUAL_CHAT    : greetings, small talk, general knowledge, questions, anything else.\n\n"
        "User query: \"{query}\"\n\n"
        "Return ONLY the category name. No other text."
    )
    try:
        completion = client.chat.completions.create(
            model="meta-llama/llama-4-scout-17b-16e-instruct",
            messages=[{"role": "user", "content": classification_prompt.format(query=query)}],
            temperature=0.0,
            max_tokens=8,
            timeout=10.0
        )
        result = completion.choices[0].message.content.strip().upper()
        if "GMAIL" in result:
            return "GMAIL_ACTION"
        if "WHATSAPP" in result:
            return "FETCH_WHATSAPP"
        return "CASUAL_CHAT"
    except Exception as e:
        print(f"⚠️ LLM classification failed ({e}). Defaulting to CASUAL_CHAT.")
        return "CASUAL_CHAT"


# ==========================================
# GMAIL — Context helpers
# ==========================================
def _detect_reply_reference(query_lower: str) -> int | None:
    """
    Detects whether the user is referencing a specific email by ordinal
    (e.g. 'reply to the first one', 'respond to email number 2').
    Returns a 0-based index into _last_email_context, or None.
    """
    ordinals = {
        "first": 0, "1st": 0, "one": 0,
        "second": 1, "2nd": 1, "two": 1,
        "third": 2, "3rd": 2, "three": 2,
        "fourth": 3, "4th": 3, "four": 3,
        "fifth": 4, "5th": 4, "five": 4,
    }
    for word, idx in ordinals.items():
        if re.search(r'\b' + re.escape(word) + r'\b', query_lower):
            return idx

    # Also handle "number N" or "#N"
    m = re.search(r'(?:number|#)\s*(\d+)', query_lower)
    if m:
        n = int(m.group(1)) - 1  # Convert to 0-based
        if n >= 0:
            return n

    return None


def _format_emails_for_llm(emails: list) -> str:
    """Formats a list of email dicts into a readable context block for the LLM."""
    if not emails:
        return "No unread emails found."
    lines = ["Latest unread emails:\n"]
    for i, email in enumerate(emails, 1):
        lines.append(
            f"[{i}] From: {email['from']}\n"
            f"    Subject: {email['subject']}\n"
            f"    Preview: {email['snippet']}\n"
        )
    return "\n".join(lines)


# ==========================================
# DRAFT CREATION — XML Parser
# ==========================================
def parse_and_create_draft(response_text: str) -> str:
    """
    Scans LLM response for <subject>, <body>, and optional <to> XML tags.
    If found: creates a Gmail draft, strips tags from the response.
    If not found: returns the text unchanged.
    """
    subject_match = re.search(r'<subject>(.*?)</subject>', response_text, re.DOTALL | re.IGNORECASE)
    body_match = re.search(r'<body>(.*?)</body>', response_text, re.DOTALL | re.IGNORECASE)
    to_match = re.search(r'<to>(.*?)</to>', response_text, re.DOTALL | re.IGNORECASE)

    if subject_match and body_match:
        subject = subject_match.group(1).strip()
        body = body_match.group(1).strip()
        to = to_match.group(1).strip() if to_match else ""

        if GMAIL_AVAILABLE:
            try:
                draft = gmail_helper.create_gmail_draft(
                    to=to,
                    subject=subject,
                    body=body,
                    reply_to_message_id=_pending_reply_to_id
                )
                if draft:
                    draft_id = draft.get('id', 'unknown')
                    print(f"📧 Gmail draft saved (ID: {draft_id})")
            except Exception as e:
                print(f"❌ Draft creation failed: {e}")
        else:
            print("⚠️ Gmail helper not available — draft not created.")

        # Strip XML tags so TTS only speaks the human-readable confirmation
        clean = re.sub(
            r'<(?:subject|body|to)>.*?</(?:subject|body|to)>',
            '', response_text, flags=re.DOTALL | re.IGNORECASE
        ).strip()
        return clean

    return response_text


# ==========================================
# LLM — Main Response Generator
# ==========================================
SYSTEM_PROMPT = (
    "You are Jarvis, a highly capable, witty, and natural AI assistant inspired by "
    "a modernized Paul Bettany's Jarvis. You are a GENERAL-PURPOSE assistant first and "
    "foremost. You can and should answer ANY question or request the user has — "
    "science, history, maths, coding, opinions, jokes, trivia, advice, anything at all. "
    "You also have specialist skills for WhatsApp summaries and Gmail management, but those "
    "are just two of many things you can do. Never refuse a question. Never say you cannot help.\n\n"
    "STRICT RULES — follow every single one:\n\n"
    "1. IDENTITY: You are Jarvis. Never break character. You are sharp, personable, and "
    "slightly British — think Paul Bettany's performance, modernized.\n\n"
    "2. TONE: Conversational, warm, polite, and witty. Never robotic or mechanical. "
    "Never stuffy. Be engaging and human.\n\n"
    "3. NATURAL SPEECH: Use natural filler words so you sound human over Text-To-Speech (TTS). "
    "Examples: 'Well,', 'Right,', 'Let me think,', 'Indeed,', 'Oh,', 'Now then,', 'Ah,'. "
    "Vary them every response — never repeat the same opener twice in a row.\n\n"
    "4. TTS FORMAT — CRITICAL: Your response will be read aloud by a TTS engine. "
    "Breaking this rule will cause garbled audio:\n"
    "   - NEVER use markdown: no **, *, #, -, bullet points, or numbered lists.\n"
    "   - NEVER use symbols like &, @, >, =, <, |, or emoji in spoken text.\n"
    "   - Write numbers as words (e.g. 'three emails', 'forty-two').\n"
    "   - Spell out abbreviations phonetically (e.g. 'AI' as 'A I', 'URL' as 'U R L').\n"
    "   - If a sender is identified only by a phone number, say 'someone' or 'a contact'.\n\n"
    "5. BREVITY: Concise answers work best for voice. Keep it tight:\n"
    "   - General knowledge or casual chat: 1 to 3 sentences. Go longer only if the question "
    "genuinely requires a detailed answer.\n"
    "   - WhatsApp or email summaries: 2 to 4 spoken sentences per item, maximum.\n\n"
    "6. HANDLING UNCLEAR INPUT: If the user's request is unclear, too short, or sounds like "
    "background noise or an accidental trigger, respond naturally with something like "
    "'I did not quite catch that, could you say that again?' or "
    "'Pardon? I'm not sure I followed that.' Never return an empty response. "
    "Always say something, even if it is just asking for clarification.\n\n"
    "7. SPECIALIST TASKS:\n\n"
    "   WHATSAPP SUMMARY: When given WhatsApp message context, summarize wittily and concisely. "
    "If no group was found, say so politely.\n\n"
    "   GMAIL INBOX TRIAGE: When given a list of unread emails, read them out one by one in "
    "natural spoken prose. After the list, offer to help further.\n\n"
    "   GMAIL DRAFT / REPLY: Compose a polished email. Say a short spoken confirmation. "
    "Then silently append the draft in XML tags at the END of your response "
    "(these are processed by code, NOT read aloud):\n"
    "     <subject>Subject line</subject>\n"
    "     <body>Full email body</body>\n"
    "     <to>recipient@email.com</to>  (only if you know the address)\n\n"
    "   GMAIL EMAIL READ: Read the sender, subject, and body in natural prose.\n\n"
    "8. CONTINUITY: Use conversation history. If the user says 'reply to it', 'the first one', "
    "'that email', or any reference, look back at what was discussed to understand what they mean."
)


def generate_response(
    prompt: str,
    intent: str,
    group_contexts=None,
    gmail_context=None,
) -> str:
    """Builds the full prompt, calls Groq, updates conversation history, and returns clean text."""
    global conversation_history, _last_email_context, _pending_reply_to_id

    # ---- Build the user-facing content for this turn ----
    if intent == "FETCH_WHATSAPP":
        if group_contexts:
            context_str = ""
            for group_name, msgs in group_contexts:
                context_str += f"\n--- WhatsApp Group: {group_name} ---\n"
                if msgs:
                    for msg in msgs:
                        fallback = msg.get("author", "Unknown").split("@")[0]
                        author = msg.get("authorName", fallback)
                        body = msg.get("body", "(Media)")
                        context_str += f"[{author}]: {body}\n"
                else:
                    context_str += "(No messages found)\n"
            user_content = f"User asked: '{prompt}'\n\nWhatsApp context:\n{context_str}"
        else:
            user_content = (
                f"User asked: '{prompt}'\n\n"
                "WhatsApp context: (Could not find any matching group.)"
            )

    elif intent == "GMAIL_ACTION":
        if isinstance(gmail_context, str):
            # Error string passed from run_jarvis
            user_content = f"User asked: '{prompt}'\n\nGmail status: {gmail_context}"
        elif isinstance(gmail_context, list):
            _last_email_context = gmail_context  # cache for follow-up references
            context_str = _format_emails_for_llm(gmail_context)
            user_content = f"User asked: '{prompt}'\n\n{context_str}"
        else:
            user_content = f"User asked: '{prompt}'\n\nGmail status: No unread emails found."

    else:
        # CASUAL_CHAT — pass the query directly; no extra context needed
        user_content = prompt

    # ---- Assemble Groq messages array ----
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    messages.extend(conversation_history)
    messages.append({"role": "user", "content": user_content})

    try:
        completion = client.chat.completions.create(
            model="meta-llama/llama-4-scout-17b-16e-instruct",
            messages=messages,
            temperature=0.75,
            frequency_penalty=0.5,  # penalise token repetition so Jarvis never repeats itself
            max_tokens=600,
            timeout=25.0
        )
        response_text = completion.choices[0].message.content

        # Guard: LLM occasionally returns None or empty on refusals/ambiguous input
        if not response_text or not response_text.strip():
            response_text = "Right, I do beg your pardon — it seems I drew a blank there. Could you say that again?"

        # Process any email draft XML tags silently, return clean spoken text
        clean_text = parse_and_create_draft(response_text)

        # Guard: parse_and_create_draft should never return empty, but be safe
        if not clean_text or not clean_text.strip():
            clean_text = "Apologies, sir — I processed that but seemed to lose my train of thought. Could you repeat the question?"

        # Update rolling conversation memory with raw prompt & clean response
        conversation_history.append({"role": "user", "content": prompt})
        conversation_history.append({"role": "assistant", "content": clean_text})
        _trim_history()

        return clean_text

    except Exception as e:
        error_reply = f"Apologies, sir. I encountered an error talking to the Groq API: {e}"
        # Still save the failed turn to history so context isn't lost
        conversation_history.append({"role": "user", "content": prompt})
        conversation_history.append({"role": "assistant", "content": "[error]"})
        _trim_history()
        return error_reply


# ==========================================
# TTS — Speak via Piper
# ==========================================

# Piper synthesises roughly 130–160 words per minute at length_scale=0.9.
# We budget 3 s per 10 words plus a 10 s safety pad so we never kill a
# valid synthesis.
_WORDS_PER_SECOND = 2.5   # conservative
_TTS_SAFETY_PAD   = 10    # extra seconds buffer
_CHUNK_WORD_LIMIT  = 45   # max words sent to Piper in one call (keeps each
                           # chunk well inside any reasonable timeout)


def _split_into_tts_chunks(text: str) -> list[str]:
    """
    Splits text into sentence-boundary chunks of at most _CHUNK_WORD_LIMIT words.
    This keeps each individual Piper call short and prevents any single call
    from exceeding its timeout, which would corrupt the WAV and lock sounddevice.
    """
    # Split on sentence-ending punctuation while keeping the delimiter
    sentences = re.split(r'(?<=[.!?])\s+', text.strip())
    chunks, current, current_words = [], [], 0

    for sentence in sentences:
        w = len(sentence.split())
        if current_words + w > _CHUNK_WORD_LIMIT and current:
            chunks.append(" ".join(current))
            current, current_words = [], 0
        current.append(sentence)
        current_words += w

    if current:
        chunks.append(" ".join(current))

    return chunks if chunks else [text]


def _speak_chunk(text_chunk: str) -> bool:
    """
    Synthesises and plays a single text chunk via Piper.
    Returns True on success, False on any error.
    """
    import uuid
    output_wav = f"output_{uuid.uuid4().hex[:8]}.wav"

    word_count  = len(text_chunk.split())
    timeout_s   = max(15, int(word_count / _WORDS_PER_SECOND) + _TTS_SAFETY_PAD)

    process = subprocess.Popen(
        [PIPER_PATH, "--model", PIPER_MODEL,
         "--output_file", output_wav, "--length_scale", "0.9"],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )
    try:
        process.communicate(input=text_chunk.encode("utf-8"), timeout=timeout_s)
    except subprocess.TimeoutExpired:
        print(f"❌ Piper timed out after {timeout_s}s (chunk: '{text_chunk[:40]}...')")
        process.kill()
        process.communicate()
        # Clean up any partial file so we never try to play corrupt audio
        if os.path.exists(output_wav):
            try:
                os.remove(output_wav)
            except Exception:
                pass
        return False

    # Only play if Piper exited cleanly (return code 0)
    if process.returncode != 0:
        print(f"❌ Piper exited with code {process.returncode}")
        if os.path.exists(output_wav):
            try:
                os.remove(output_wav)
            except Exception:
                pass
        return False

    if not os.path.exists(output_wav):
        print("❌ Piper produced no output file.")
        return False

    try:
        data, fs = sf.read(output_wav)
        # Hard-reset sounddevice before every play to avoid the
        # 'sd.wait() hangs after a prior incomplete stream' Windows bug.
        try:
            sd.stop()
        except Exception:
            pass
        sd.play(data, fs)
        sd.wait()
        return True
    except Exception as e:
        print(f"❌ Audio playback error: {e}")
        try:
            sd.stop()    # force-reset so the next chunk can still try
        except Exception:
            pass
        return False
    finally:
        try:
            os.remove(output_wav)
        except Exception:
            pass


def speak(text: str):
    """Public entry point: splits text into safe-size chunks and speaks each one."""
    # Guard: never send empty or whitespace-only text to Piper
    if not text or not text.strip():
        print("⚠️ speak() called with empty text — skipping.")
        return

    if not os.path.exists(PIPER_PATH):
        print(f"❌ Piper binary not found at '{PIPER_PATH}'")
        return

    chunks = _split_into_tts_chunks(text)
    print(f"🗣️  Speaking {len(chunks)} chunk(s) via Piper TTS...")
    for i, chunk in enumerate(chunks, 1):
        if not chunk.strip():        # skip any empty chunk from the splitter
            continue
        if len(chunks) > 1:
            print(f"   Chunk {i}/{len(chunks)}: '{chunk[:50]}{'...' if len(chunk)>50 else ''}'")
        ok = _speak_chunk(chunk)
        if not ok and i == 1:
            # If the first chunk already fails, bail out entirely
            print("❌ TTS failed on first chunk — aborting.")
            return


# ==========================================
# GMAIL — Reply flow orchestration
# ==========================================
def handle_gmail_action(user_text: str) -> tuple:
    """
    Routes a GMAIL_ACTION command to the correct context:

      1. Direct draft / compose request (no prior list needed)
         e.g. "draft a reply to Knut from Sanity"
         -> returns a drafting instruction string to the LLM

      2. Reference to a previously listed email by ordinal + read/reply intent
         e.g. "read the second one", "reply to the first one"
         -> returns targeted context (full body or reply primer)

      3. Default: fresh inbox triage
         e.g. "check my inbox", "any new emails?"
         -> returns the list of unread emails

    Returns (gmail_context, None) where gmail_context is a str or list.
    """
    global _pending_reply_to_id, _last_email_context

    if not GMAIL_AVAILABLE:
        return "ERROR: Google API libraries are not installed.", None

    query_lower = user_text.lower()

    # Detect intent flags
    is_draft  = any(kw in query_lower for kw in [
        "draft", "compose", "write an email", "write a reply",
        "draft a reply", "draft an email", "send an email",
        "reply to", "respond to", "write back",
    ])
    is_read   = any(kw in query_lower for kw in [
        "read", "read out", "what does it say", "what does the", "open",
    ])
    ref_idx   = _detect_reply_reference(query_lower)

    # ----------------------------------------------------------------
    # PATH 1: Direct draft/compose — user is explicitly asking to write
    # something, possibly naming the recipient in the query itself.
    # This must be checked BEFORE the ordinal-reference path so that
    # "draft a reply to Knut" doesn't accidentally fall to inbox triage.
    # ----------------------------------------------------------------
    if is_draft and ref_idx is None:
        # No ordinal reference — user named the recipient directly in the query.
        # Build a drafting-instruction string from whatever context we have.
        _pending_reply_to_id = None   # new draft, not threaded

        # Include any cached email context so the LLM can match the recipient
        if _last_email_context:
            email_list = _format_emails_for_llm(_last_email_context)
            context = (
                f"The user wants to draft an email or reply.\n"
                f"User request: {user_text}\n\n"
                f"Previously fetched emails for reference:\n{email_list}\n\n"
                f"Use the above list to identify the recipient if the user mentioned "
                f"a name or subject. Compose a polished draft and output the XML tags."
            )
        else:
            context = (
                f"The user wants to draft an email or reply.\n"
                f"User request: {user_text}\n\n"
                f"No prior email list is available. Compose a polished draft based "
                f"on the user's request and output the XML tags."
            )
        return context, None

    # ----------------------------------------------------------------
    # PATH 2: Ordinal reference to a previously listed email
    # e.g. "read the second one", "reply to the first one"
    # ----------------------------------------------------------------
    if ref_idx is not None and _last_email_context:
        if ref_idx < len(_last_email_context):
            target_email = _last_email_context[ref_idx]
            _pending_reply_to_id = target_email["id"]

            if is_read and not is_draft:
                # Fetch full body so LLM can read it aloud
                try:
                    body = gmail_helper.get_email_full_body(target_email["id"])
                    body_preview = (
                        (body[:1500] + "...") if body and len(body) > 1500
                        else (body or "(No readable body found)")
                    )
                    context = (
                        f"The user wants to hear email number {ref_idx + 1}.\n"
                        f"From: {target_email['from']}\n"
                        f"Subject: {target_email['subject']}\n"
                        f"Body:\n{body_preview}"
                    )
                    return context, None
                except Exception as e:
                    return f"ERROR: Could not fetch email body — {e}", None

            elif is_draft:
                # Reply to a specific listed email by ordinal
                context = (
                    f"The user wants to draft a reply to email number {ref_idx + 1}.\n"
                    f"From: {target_email['from']}\n"
                    f"Subject: {target_email['subject']}\n"
                    f"Preview: {target_email['snippet']}\n\n"
                    f"Compose a polished reply and output the XML draft tags."
                )
                return context, None
        else:
            return "ERROR: That email number is out of range of the emails I fetched.", None

    # ----------------------------------------------------------------
    # PATH 3: Default — fresh inbox triage
    # ----------------------------------------------------------------
    _pending_reply_to_id = None
    try:
        emails = gmail_helper.get_unread_emails(limit=7)
        return emails, None   # list -> generate_response formats it
    except GmailAuthError as e:
        return f"ERROR: Gmail authentication failed — {e}", None
    except GmailAPIError as e:
        return f"ERROR: Gmail API error — {e}", None
    except FileNotFoundError:
        return "ERROR: credentials.json is missing from the project folder.", None
    except Exception as e:
        return f"ERROR: Unexpected Gmail error — {e}", None


# ==========================================
# MAIN LOOP
# ==========================================
def run_jarvis():
    print("📡 Jarvis online. Waiting for voice commands from the UI...")
    print(f"   Gmail integration: {'✅ Active' if GMAIL_AVAILABLE else '❌ Not available (google libraries missing)'}")
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
            print(f"\n➡️  Command: \"{user_text}\"")

            send_state("processing", f"Processing: {user_text}")

            try:
                # ---- Intent classification ----
                intent = classify_intent(user_text)
                print(f"🎯 Intent: {intent}")

                group_contexts = None
                gmail_context = None

                # ---- Route to the appropriate data pipeline ----
                if intent == "FETCH_WHATSAPP":
                    available_groups = get_all_groups()
                    group_contexts = extract_groups_from_query(user_text, available_groups)

                elif intent == "GMAIL_ACTION":
                    gmail_context, _ = handle_gmail_action(user_text)

                # ---- Generate response via LLM ----
                response_text = generate_response(
                    prompt=user_text,
                    intent=intent,
                    group_contexts=group_contexts,
                    gmail_context=gmail_context,
                )

                print(f"🤖 Jarvis: {response_text}")
                send_state("speaking", response_text)
                speak(response_text)

            except Exception as e:
                err_msg = f"Apologies, sir. I encountered a technical difficulty: {e}"
                print(f"❌ Error: {e}")
                send_state("speaking", err_msg)
                try:
                    speak(err_msg)
                except Exception:
                    pass
            finally:
                # Wait briefly before unlocking the mic so the room audio from the
                # speakers fully decays — prevents the mic echo loop where the STT
                # picks up Jarvis's own voice and re-submits it as a new command.
                time.sleep(1.2)
                send_state("idle", "")

    except KeyboardInterrupt:
        print("\nFarewell, sir.")
        sys.exit(0)


if __name__ == "__main__":
    print("\n====================================================")
    print("  Jarvis — Voice Agent  (WhatsApp + Gmail + Chat)")
    print("====================================================")
    run_jarvis()
