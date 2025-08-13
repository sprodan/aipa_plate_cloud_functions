import OpenAI from "openai";

/** Блок контента нового формата */
export type OpenAIContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** Сообщение нового формата (developer/user/assistant) */
export type OpenAIMessage = {
  role: "developer" | "user" | "assistant";
  content: OpenAIContentBlock[];
};

export interface OpenAIRequest {
  model: string; // "gpt-5" | "gpt-5-mini" | "gpt-5-nano" ...
  messages: OpenAIMessage[];
  responseFormat?: "json_object" | "text";
  reasoningEffort?: "low" | "medium" | "high";
  tools?: unknown[]; // при необходимости можно прокинуть инструменты
}

/** Результат вызова */
export interface OpenAIResult {
  text: string; // извлечённая текстовая часть (или JSON-строка)
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  raw: unknown;
}

let client: OpenAI | null = null;

/** Ленивая инициализация клиента по секрету */
export function getOpenAI(): OpenAI {
  if (client) return client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    throw new Error("OPENAI_API_KEY is not set. Configure the secret.");
  }
  client = new OpenAI({apiKey});
  return client;
}

/** Удобный хелпер для создания текстового сообщения нового формата */
export function textMsg(
  role: "developer" | "user" | "assistant",
  text: string
): OpenAIMessage {
  return {role, content: [{type: "text", text}]};
}

/** Удобный хелпер для создания сообщения с изображением */
export function imageMsg(
  role: "user",
  imageUrl: string,
  textContent?: string
): OpenAIMessage {
  const content: OpenAIContentBlock[] = [];

  if (textContent) {
    content.push({type: "text", text: textContent});
  }

  content.push({type: "image_url", image_url: {url: imageUrl}});

  return {role, content};
}

/** Извлечение текста из нового формата ответа Chat Completions */
function extractTextFromChat(raw: unknown): {
  text: string;
  usage?: OpenAIResult["usage"];
} {
  const cc = raw as {
    choices?: Array<{
      message?: { content?: string | OpenAIContentBlock[] };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };

  const content = cc?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return {text: content, usage: cc.usage};
  }
  if (Array.isArray(content)) {
    const firstText = content.find((b) => b?.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    return {text: firstText?.text ?? "", usage: cc.usage};
  }
  return {text: "", usage: cc?.usage};
}

/**
 * Единая точка вызова OpenAI Chat Completions (новый контракт).
 * Важно: здесь НЕТ temperature и max_tokens.
 */
export async function callOpenAI(req: OpenAIRequest): Promise<OpenAIResult> {
  const openai = getOpenAI();

  const res = await openai.chat.completions.create({
    model: req.model,
    messages: req.messages as OpenAI.Chat.ChatCompletionMessageParam[], // Приводим к нужному типу для OpenAI API
    response_format: req.responseFormat ? {type: req.responseFormat} : undefined,
    reasoning_effort: req.reasoningEffort,
  });

  const {text, usage} = extractTextFromChat(res);
  return {text, usage, raw: res};
}

/* ----------- Генерация изображений (без изменений контракта) ----------- */

export interface OpenAIImageRequest {
  model: string; // "gpt-image-1" | "dall-e-3" ...
  prompt: string;
  size?: "256x256" | "512x512" | "1024x1024";
  quality?: "standard" | "hd";
  style?: "vivid" | "natural";
  background?: "transparent" | "white" | "auto";
  count?: 1 | 2 | 3 | 4; // для dall-e-3 всегда 1
}

export interface OpenAIImageResult {
  urls: string[];
  b64: string[];
  raw: unknown;
}

/**
 * Генерирует изображения через OpenAI Images API.
 * Для "dall-e-3" всегда создаёт одно изображение.
 * @param req Параметры: модель, промпт, размер и опции качества/стиля.
 * @returns Объект с массивами urls и b64, а также сырым ответом SDK.
 */
export async function callOpenAIImage(
  req: OpenAIImageRequest
): Promise<OpenAIImageResult> {
  const openai = getOpenAI();

  const isDalle3 = req.model === "dall-e-3";
  const n = isDalle3 ? 1 : (req.count ?? 1);

  const res = await openai.images.generate({
    model: req.model,
    prompt: req.prompt,
    size: req.size ?? "1024x1024",
    quality: req.quality,
    style: req.style,
    n,
  });

  const data = (res as { data?: Array<{ url?: string; b64_json?: string }> }).data ?? [];
  const urls = data.map((d) => d.url).filter((u): u is string => !!u);
  const b64 = data.map((d) => d.b64_json).filter((b): b is string => !!b);
  return {urls, b64, raw: res};
}
