/**
 * Response-language preferences.
 *
 * Native audio Live models choose the spoken language automatically and do not
 * accept an explicit `languageCode`. The docs recommend stating the required
 * language in the system instructions, which is what the server does with
 * this preference. Codes are a subset of the Live API's documented list.
 */
export const LANGUAGES = [
  { code: "auto", label: "Match the speaker" },
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "pt-BR", label: "Portuguese (Brazil)" },
  { code: "nl", label: "Dutch" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh-Hans", label: "Chinese (Simplified)" },
  { code: "hi", label: "Hindi" },
  { code: "ar", label: "Arabic" },
  { code: "tr", label: "Turkish" },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]["code"];

export const LANGUAGE_CODES = LANGUAGES.map((language) => language.code) as [
  LanguageCode,
  ...LanguageCode[],
];

export function languageLabel(code: LanguageCode): string {
  return LANGUAGES.find((language) => language.code === code)?.label ?? code;
}
