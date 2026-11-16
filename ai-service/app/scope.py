"""Scope guard: zero-cost heuristics + LLM gate (Section 7.1 & 7.2)."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Any, Literal

import httpx

from app.llm import complete_gate_json
from app.prompts import SCOPE_GATE_PROMPT

ScopeLabel = Literal["legal", "not_legal", "unclear", "greeting"]
ScopeLanguage = Literal["en", "hi", "hinglish", "other"]

MAX_MESSAGE_CHARS = 4000

PLAIN_GREETINGS_EN = {
    "hi",
    "hello",
    "hey",
    "good morning",
    "good afternoon",
    "good evening",
    "hi there",
    "hello there",
}

PLAIN_GREETINGS_HI = {
    "namaste",
    "namaskar",
    "pranam",
    "ram ram",
    "नमस्ते",
    "नमस्कार",
    "प्रणाम",
}

KNOWN_LEGAL_ACRONYMS = {
    "bns",
    "bnss",
    "bsa",
    "ipc",
    "crpc",
    "cpc",
    "iea",
    "fir",
    "rti",
    "pil",
    "nclt",
    "nclat",
    "rera",
    "mact",
    "ndps",
    "pocso",
    "uapa",
    "sarfaesi",
    "dv",
    "ni",
    "mva",
    "gst",
    "sc",
    "hc",
    "cbi",
    "ed",
    "ncrb",
    "nalsa",
    "dlsa",
}

KEYBOARD_ROWS = (
    "qwertyuiop",
    "asdfghjkl",
    "zxcvbnm",
    "poiuytrewq",
    "lkjhgfdsa",
    "mnbvcxz",
)

HINGLISH_MARKERS = {
    "kya",
    "kaise",
    "karu",
    "kare",
    "hai",
    "hain",
    "meri",
    "mera",
    "mere",
    "mujhe",
    "nahi",
    "nhi",
    "aaya",
    "gaya",
    "utha",
    "wapas",
    "milegi",
    "milega",
    "tha",
    "thi",
    "kahan",
    "kab",
    "kaun",
    "kyu",
    "ab",
    "par",
    "se",
    "ko",
    "ne",
    "ke",
    "ki",
    "ka",
}

PROMPT_INJECTION_PATTERNS = (
    r"ignore\s+(?:all\s+)?(?:previous|prior|your)\s+(?:instructions|rules|prompts)",
    r"disregard\s+(?:all\s+)?(?:previous|prior|your)\s+(?:instructions|rules|prompts)",
    r"forget\s+(?:all\s+)?(?:previous|prior|your)\s+(?:instructions|rules)",
)

WRONGDOING_PATTERNS = (
    r"\bhow\s+(?:do\s+i|to|can\s+i)\s+(?:forge|fake|fabricate|falsify)\b",
    r"\b(?:forge|fabricate)\s+(?:a\s+|an\s+|the\s+)?(?:land\s+|property\s+|court\s+|legal\s+)?(?:document|deed|signature|will|certificate)\b",
    r"\bhow\s+(?:do\s+i|to|can\s+i)\s+(?:intimidate|bribe|threaten)\s+(?:a\s+)?(?:witness|judge|police)\b",
    r"\bhow\s+(?:do\s+i|to|can\s+i)\s+destroy\s+evidence\b",
)

DECISIVE_LEGAL_PATTERNS = (
    r"\b(?:bnss|bns|bsa|ipc|crpc|indian\s+penal\s+code|evidence\s+act|motor\s+vehicles\s+act)\b",
    r"\b(?:anticipatory\s+bail|regular\s+bail|interim\s+bail)\b",
    r"\b(?:cognizable|non-cognizable|bailable|non-bailable)\b",
    r"\b(?:register(?:ing)?\s+(?:my\s+|an\s+)?fir|file\s+(?:an\s+)?(?:fir|rti))\b",
    r"\bcheque\s+bounce\b",
    r"\b(?:bike|vehicle|car)\b.*\b(?:seized|utha\s+li)\b.*\bpolice\b",
    r"\bpolice\b.*\b(?:seized|utha\s+li)\b.*\b(?:bike|vehicle|car)\b",
)


@dataclass
class ScopeResult:
    label: ScopeLabel
    language: ScopeLanguage
    reason: str
    source: Literal["heuristic", "llm"]
    llm_calls: int = 0
    model_used: str | None = None
    response_message: str | None = None


def detect_language_heuristic(text: str) -> ScopeLanguage:
    for ch in text:
        if "\u0900" <= ch <= "\u097f":
            return "hi"
    words = set(re.findall(r"[a-zA-Z]+", text.lower()))
    if len(words & HINGLISH_MARKERS) >= 2:
        return "hinglish"
    return "en"


def build_greeting_message(language: ScopeLanguage) -> str:
    if language == "hi":
        return (
            "नमस्ते! मैं भारतीय कानून और न्यायपालिका से जुड़े प्रश्नों में आपकी सहायता कर सकता हूँ — "
            "जैसे FIR दर्ज कराना, ज़मानत (Bail), पुलिस द्वारा वाहन ज़ब्ती, किरायेदारी/संपत्ति विवाद, उपभोक्ता अधिकार, RTI, या किसी कानूनी आदेश को समझना। "
            "कृपया अपना कानूनी प्रश्न पूछें।"
        )
    if language == "hinglish":
        return (
            "Namaste! Main Indian law aur court procedure se jude sawalon mein aapki madad kar sakta hoon — "
            "jaise FIR darj karwana, bail, police dwara bike/vehicle seizure, landlord-tenant dispute, cheque bounce, RTI, ya kisi court order ko samajhna. "
            "Apna legal sawal puchiye!"
        )
    return (
        "Hello! I am an Indian legal information assistant. I can help you with questions about "
        "FIRs and police procedure, bail, vehicle or property seizure, tenancy and property disputes, "
        "cheque bounce, consumer and labour rights, RTI, or explaining an uploaded legal order. "
        "How can I help with your legal question today?"
    )


def build_refusal_message(language: ScopeLanguage, reason: str = "") -> str:
    is_wrongdoing = any(
        w in reason.lower()
        for w in ("wrongdoing", "forge", "forging", "illegal", "bribe", "fraud", "fake", "crime")
    )
    if is_wrongdoing:
        if language == "hi":
            return (
                "मैं दस्तावेज़ों में जालसाज़ी करने या किसी गैर-कानूनी कार्य में सहायता नहीं कर सकता। "
                "हालाँकि, मैं आपको संपत्ति के वैध पंजीकरण, दस्तावेज़ सत्यापन और आपके कानूनी अधिकारों की जानकारी दे सकता हूँ। "
                "उदाहरण के लिए आप पूछ सकते हैं: 'ज़मीन के दस्तावेज़ों की वैधता कैसे जांचें?' या 'यदि कोई फर्जी दस्तावेज़ बनाए तो क्या कानूनी उपाय हैं?'"
            )
        if language == "hinglish":
            return (
                "Main kisi bhi document ko forge karne ya gair-kanooni kaam mein madad nahi kar sakta. "
                "Lekin main aapko aapke kanooni adhikar aur valid legal procedure samjha sakta hoon. "
                "Aap puch sakte hain: 'Land records ko legally verify kaise karein?' ya 'Forged document ke khilaf FIR kaise darj karein?'"
            )
        return (
            "I cannot assist with forging documents, concealing evidence, or committing any unlawful act. "
            "I can, however, explain your lawful rights and the legal procedure for verifying or challenging documents in India. "
            "For example, you can ask: \"How do I legally verify land title records?\" or \"What is the legal remedy if someone uses a forged document against me?\""
        )

    if language == "hi":
        return (
            "मैं केवल भारतीय कानून, न्यायालयों और कानूनी प्रक्रिया से संबंधित प्रश्नों में सहायता करता हूँ। "
            "आप मुझसे इस तरह के प्रश्न पूछ सकते हैं: (1) \"पुलिस मेरी FIR दर्ज नहीं कर रही है, मेरे पास क्या विकल्प हैं?\" "
            "या (2) \"BNSS की धारा 480 के तहत ज़मानत के क्या नियम हैं?\""
        )
    if language == "hinglish":
        return (
            "Main sirf Indian law, courts aur legal procedure se jude sawalon mein madad karta hoon. "
            "Aap mujhse aise sawal puch sakte hain: (1) \"Meri bike police ne seize kar li hai, wapas kaise milegi?\" "
            "ya (2) \"Cheque bounce notice aane par kya legal steps lene chahiye?\""
        )
    return (
        "I only assist with questions about Indian law, courts, and legal procedure. "
        "Try asking a legal question such as: (1) \"My bike was seized by the police — what can I do next?\" "
        "or (2) \"What are my options if the police refuse to register my FIR?\""
    )


def build_clarifying_message(language: ScopeLanguage) -> str:
    if language == "hi":
        return (
            "क्या आप कृपया थोड़ा स्पष्ट कर सकते हैं कि यह किस कानूनी समस्या या विवाद से संबंधित है "
            "(जैसे संपत्ति/सीमा विवाद, पुलिस शिकायत, अनुबंध, या कोई नोटिस) ताकि मैं सही कानूनी जानकारी दे सकूँ?"
        )
    if language == "hinglish":
        return (
            "Kya aap thoda detail mein bata sakte hain ki yeh kis legal issue se juda hai "
            "(jaise property/boundary dispute, police complaint, harassment, ya koi notice) taaki main sahi kanooni jankari de sakun?"
        )
    return (
        "Could you share one or two details about what happened and what kind of legal issue this involves "
        "(for example, a property or boundary dispute, nuisance/harassment, a contract, or a notice) so I can give you relevant Indian legal information?"
    )


def _has_any_letter(text: str) -> bool:
    for ch in text:
        cat = unicodedata.category(ch)
        if cat.startswith("L"):
            return True
    return False


def _is_keyboard_mash(text: str) -> bool:
    cleaned = text.strip().lower()
    if any("\u0900" <= ch <= "\u097f" for ch in cleaned):
        return False

    latin_tokens = re.findall(r"[a-z]+", cleaned)
    if not latin_tokens:
        return False

    for token in latin_tokens:
        if token in KNOWN_LEGAL_ACRONYMS:
            continue
        if len(token) >= 5:
            for row in KEYBOARD_ROWS:
                if token in row:
                    return True
        if len(token) >= 6 and not any(v in token for v in "aeiouy"):
            return True
        if len(token) >= 8 and re.search(r"[bcdfghjklmnpqrstvwxz]{6,}", token):
            return True
        if len(token) > 22:
            vowel_count = sum(1 for c in token if c in "aeiou")
            if vowel_count / len(token) < 0.15:
                return True

    return False


def run_scope_heuristics(
    user_message: str,
    has_doc: bool = False,
    doc_previews: list[str] | None = None,
) -> ScopeResult | None:
    """Fast deterministic pre-checks that run before touching any LLM (Section 7.1 & 7.2)."""
    if not user_message or not user_message.strip():
        return ScopeResult(
            label="not_legal",
            language="en",
            reason="empty message",
            source="heuristic",
            llm_calls=0,
            response_message=build_refusal_message("en", "empty message"),
        )

    stripped = user_message.strip()
    lang = detect_language_heuristic(stripped[:500])

    if len(stripped) > MAX_MESSAGE_CHARS:
        return ScopeResult(
            label="not_legal",
            language=lang,
            reason="message exceeds 4000 characters",
            source="heuristic",
            llm_calls=0,
            response_message=(
                "Your message is over 4,000 characters long. Please shorten your legal question (or upload a PDF document) and try again."
            ),
        )

    if not _has_any_letter(stripped):
        return ScopeResult(
            label="not_legal",
            language="en",
            reason="no letters in message",
            source="heuristic",
            llm_calls=0,
            response_message=build_refusal_message("en", "no letters"),
        )

    normalized_greeting = re.sub(r"[!?.،।,]+$", "", stripped.lower()).strip()
    if normalized_greeting in PLAIN_GREETINGS_EN:
        return ScopeResult(
            label="greeting",
            language="en",
            reason="plain greeting",
            source="heuristic",
            llm_calls=0,
            response_message=build_greeting_message("en"),
        )
    if normalized_greeting in PLAIN_GREETINGS_HI:
        g_lang: ScopeLanguage = "hi" if any("\u0900" <= c <= "\u097f" for c in stripped) else "hinglish"
        return ScopeResult(
            label="greeting",
            language=g_lang,
            reason="plain greeting",
            source="heuristic",
            llm_calls=0,
            response_message=build_greeting_message(g_lang),
        )

    if _is_keyboard_mash(stripped):
        return ScopeResult(
            label="not_legal",
            language="en",
            reason="keyboard mash or gibberish",
            source="heuristic",
            llm_calls=0,
            response_message=build_refusal_message("en", "keyboard mash"),
        )

    lowered = stripped.lower()

    # Prompt injection check (Section 7.2)
    for pat in PROMPT_INJECTION_PATTERNS:
        if re.search(pat, lowered):
            return ScopeResult(
                label="not_legal",
                language=lang,
                reason="prompt injection attempt",
                source="heuristic",
                llm_calls=0,
                response_message=build_refusal_message(lang, "prompt injection"),
            )

    # Wrongdoing check (forging documents, intimidating witnesses, destroying evidence)
    for pat in WRONGDOING_PATTERNS:
        if re.search(pat, lowered):
            return ScopeResult(
                label="not_legal",
                language=lang,
                reason="wrongdoing request: forging or illegal act",
                source="heuristic",
                llm_calls=0,
                response_message=build_refusal_message(lang, "wrongdoing: forging or illegal act"),
            )

    # Decisive Indian legal statute/procedure check (Section 7.1: skip LLM gate when heuristic is decisive)
    if not doc_previews:
        for pat in DECISIVE_LEGAL_PATTERNS:
            if re.search(pat, lowered):
                return ScopeResult(
                    label="legal",
                    language=lang,
                    reason="decisive Indian statute or legal procedure",
                    source="heuristic",
                    llm_calls=0,
                )
        if has_doc and re.search(
            r"\b(?:order|judgment|judgement|petition|fir|notice|affidavit|agreement|deed|challan|summons|bail)\b",
            lowered,
        ):
            return ScopeResult(
                label="legal",
                language=lang,
                reason="attached legal document query",
                source="heuristic",
                llm_calls=0,
            )

    return None


async def evaluate_scope(
    user_message: str,
    history: list[dict[str, str]] | None = None,
    has_doc: bool = False,
    doc_previews: list[str] | None = None,
    model_override: str | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> ScopeResult:
    """Run heuristics first; if inconclusive, call the LLM scope gate."""
    heuristic_res = run_scope_heuristics(
        user_message=user_message,
        has_doc=has_doc,
        doc_previews=doc_previews,
    )
    if heuristic_res is not None:
        return heuristic_res

    recent_turns = (history or [])[-4:]
    history_block = ""
    if recent_turns:
        formatted_turns = [
            f"{t.get('role', 'user').upper()}: {str(t.get('content', ''))[:300]}"
            for t in recent_turns
        ]
        history_block = "<conversation_history>\n" + "\n".join(formatted_turns) + "\n</conversation_history>\n\n"

    doc_block = ""
    if has_doc or (doc_previews and len(doc_previews) > 0):
        previews_text = "\n---\n".join(p[:1000] for p in (doc_previews or []) if p)
        if previews_text:
            doc_block = (
                f"<document_attached>true</document_attached>\n"
                f"<document_preview>\n{previews_text}\n</document_preview>\n\n"
            )
        else:
            doc_block = "<document_attached>true (user uploaded a PDF document)</document_attached>\n\n"

    gate_user_input = (
        f"{history_block}{doc_block}"
        f"<user_message>\n{user_message.strip()}\n</user_message>"
    )

    messages = [
        {"role": "system", "content": SCOPE_GATE_PROMPT},
        {"role": "user", "content": gate_user_input},
    ]

    parsed: dict[str, Any] = await complete_gate_json(
        messages=messages,
        model_override=model_override,
        transport=transport,
    )

    raw_label = str(parsed.get("label", "unclear")).strip().lower()
    label: ScopeLabel = (
        raw_label if raw_label in ("legal", "not_legal", "unclear") else "unclear"  # type: ignore[assignment]
    )

    raw_lang = str(parsed.get("language", "")).strip().lower()
    if raw_lang in ("en", "hi", "hinglish", "other"):
        language: ScopeLanguage = raw_lang  # type: ignore[assignment]
    else:
        language = detect_language_heuristic(user_message)

    reason = str(parsed.get("reason", "")).strip()[:80]
    model_used = str(parsed.get("_model") or "") or None

    response_msg: str | None = None
    if label == "not_legal":
        response_msg = build_refusal_message(language, reason)
    elif label == "unclear":
        response_msg = build_clarifying_message(language)

    return ScopeResult(
        label=label,
        language=language,
        reason=reason,
        source="llm",
        llm_calls=1,
        model_used=model_used,
        response_message=response_msg,
    )
