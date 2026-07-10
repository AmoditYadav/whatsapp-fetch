import os
import base64
from email import policy as email_policy
from email.message import EmailMessage
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

# Scopes required to read emails and compose drafts
SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose'
]

# Resolve the absolute directory of this file, regardless of CWD
_DIR = os.path.dirname(os.path.abspath(__file__))
TOKEN_PATH = os.path.join(_DIR, 'token.json')
CREDS_PATH = os.path.join(_DIR, 'credentials.json')


class GmailAuthError(Exception):
    """Raised when OAuth credentials are missing or cannot be refreshed."""
    pass


class GmailAPIError(Exception):
    """Raised when a Gmail API call fails."""
    pass


def get_gmail_service():
    """Gets an authorized Gmail service client.
    Handles loading credentials, renewing expired tokens, or running a
    local OAuth consent flow on first run.

    Raises:
        GmailAuthError: if credentials.json is missing or auth fails.
    """
    creds = None

    # Load stored token if it exists
    if os.path.exists(TOKEN_PATH):
        try:
            creds = Credentials.from_authorized_user_file(TOKEN_PATH, SCOPES)
        except Exception as e:
            print(f"⚠️ Error loading token.json (will re-authenticate): {e}")
            creds = None

    # If credentials are not valid or loaded, attempt refresh or full auth flow
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            try:
                print("[gmail] Refreshing expired access token...")
                creds.refresh(Request())
                print("[gmail] Token refreshed successfully.")
            except Exception as e:
                print(f"⚠️ Refresh token failed: {e}. Re-authenticating...")
                creds = None

        if not creds:
            if not os.path.exists(CREDS_PATH):
                raise GmailAuthError(
                    f"credentials.json not found at '{CREDS_PATH}'. "
                    "Please place your Google OAuth client secrets file there."
                )
            print("[gmail] Starting local OAuth consent flow. A browser window will open...")
            flow = InstalledAppFlow.from_client_secrets_file(CREDS_PATH, SCOPES)
            creds = flow.run_local_server(port=0)
            print("[gmail] Authentication successful.")

        # Persist credentials for next run
        try:
            with open(TOKEN_PATH, 'w') as token_file:
                token_file.write(creds.to_json())
            print(f"[gmail] Token saved to {TOKEN_PATH}.")
        except Exception as e:
            print(f"⚠️ Could not save token.json: {e}")

    return build('gmail', 'v1', credentials=creds)


def get_unread_emails(limit=7):
    """Fetches unread emails with metadata (Subject, From, Date, Snippet).

    Args:
        limit: Maximum number of emails to fetch (default 7).

    Returns:
        A list of email dicts, or an empty list if inbox is clear.

    Raises:
        GmailAuthError: if authentication fails.
        GmailAPIError: if the Gmail API returns an error.
    """
    service = get_gmail_service()
    try:
        results = service.users().messages().list(
            userId='me', q='is:unread', maxResults=limit
        ).execute()
    except HttpError as e:
        raise GmailAPIError(f"Failed to list messages: {e}") from e

    messages = results.get('messages', [])
    if not messages:
        return []

    email_data = []
    for message in messages:
        try:
            msg = service.users().messages().get(
                userId='me',
                id=message['id'],
                format='metadata',
                metadataHeaders=['Subject', 'From', 'Date', 'Message-ID', 'In-Reply-To']
            ).execute()
        except HttpError as e:
            print(f"⚠️ Skipping message {message['id']}: {e}")
            continue

        headers = msg.get('payload', {}).get('headers', [])
        header_map = {h['name'].lower(): h['value'] for h in headers}

        email_data.append({
            'id': message['id'],
            'subject': header_map.get('subject', 'No Subject'),
            'from': header_map.get('from', 'Unknown Sender'),
            'date': header_map.get('date', ''),
            'message_id': header_map.get('message-id', ''),
            'snippet': msg.get('snippet', ''),
        })

    return email_data


def get_email_full_body(message_id):
    """Fetches the full plain-text body of a specific email by its Gmail message ID.

    Args:
        message_id: The Gmail message ID (from get_unread_emails results).

    Returns:
        The plain-text body string, or None if not found.

    Raises:
        GmailAuthError: if authentication fails.
        GmailAPIError: if the Gmail API returns an error.
    """
    service = get_gmail_service()
    try:
        msg = service.users().messages().get(
            userId='me', id=message_id, format='full'
        ).execute()
    except HttpError as e:
        raise GmailAPIError(f"Failed to get message body: {e}") from e

    def _extract_plain_text(payload):
        """Recursively extracts plain text from a MIME payload tree."""
        mime_type = payload.get('mimeType', '')
        body_data = payload.get('body', {}).get('data', '')

        if mime_type == 'text/plain' and body_data:
            return base64.urlsafe_b64decode(body_data).decode('utf-8', errors='replace')

        for part in payload.get('parts', []):
            result = _extract_plain_text(part)
            if result:
                return result
        return None

    return _extract_plain_text(msg.get('payload', {}))


def create_gmail_draft(to, subject, body, reply_to_message_id=None):
    """Creates a draft email in Gmail.

    Args:
        to: Recipient email address string (can be empty).
        subject: Email subject.
        body: Plain-text email body.
        reply_to_message_id: Optional Gmail message ID to thread reply under.

    Returns:
        The created draft resource dict, or None on failure.
    """
    service = get_gmail_service()

    message = EmailMessage()
    message.set_content(body)

    if to:
        message['To'] = to
    if subject:
        message['Subject'] = subject

    # If replying, thread the draft correctly
    if reply_to_message_id:
        try:
            orig = service.users().messages().get(
                userId='me', id=reply_to_message_id, format='metadata',
                metadataHeaders=['From', 'Subject', 'Message-ID', 'References']
            ).execute()
            orig_headers = {h['name'].lower(): h['value']
                            for h in orig.get('payload', {}).get('headers', [])}
            orig_message_id = orig_headers.get('message-id', '')
            orig_refs = orig_headers.get('references', '')

            if not to:
                message['To'] = orig_headers.get('from', '')
            if not subject:
                orig_subj = orig_headers.get('subject', '')
                message['Subject'] = orig_subj if orig_subj.startswith('Re:') else f"Re: {orig_subj}"

            if orig_message_id:
                message['In-Reply-To'] = orig_message_id
                message['References'] = f"{orig_refs} {orig_message_id}".strip()
        except Exception as e:
            print(f"⚠️ Could not thread reply (proceeding as new draft): {e}")

    # Encode to base64url format for Gmail API
    raw = base64.urlsafe_b64encode(message.as_bytes()).decode('utf-8')

    try:
        create_body = {'message': {'raw': raw}}
        if reply_to_message_id:
            # Get thread ID so the draft appears in the original thread
            try:
                orig_msg = service.users().messages().get(
                    userId='me', id=reply_to_message_id, format='minimal'
                ).execute()
                thread_id = orig_msg.get('threadId')
                if thread_id:
                    create_body['message']['threadId'] = thread_id
            except Exception:
                pass

        draft = service.users().drafts().create(userId="me", body=create_body).execute()
        return draft
    except HttpError as e:
        print(f"❌ Gmail draft creation error: {e}")
        return None
