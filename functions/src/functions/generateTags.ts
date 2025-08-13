/**
 * Generate tags with translations and colors using OpenAI
 */

import {db} from "../firebase";
import {callOpenAI, textMsg} from "../utils/openai";
import {COLLECTIONS, Tag} from "../types/firestore";
import {ALL_TAGS} from "../constants/tags";
import * as admin from "firebase-admin";

interface GeneratedTagData {
  name: string;
  labels: {
    en: string;
    ru: string;
  };
  bg_color: string;
  text_color: string;
  group: string;
}

/**
 * Generate tag metadata using OpenAI (with batching for better performance)
 */
async function generateTagsMetadata(): Promise<GeneratedTagData[]> {
  console.log("🤖 Генерируем метаданные для тегов через OpenAI...");
  console.log(`📊 Всего тегов для обработки: ${ALL_TAGS.length}`);

  // Разбиваем на батчи по 20 тегов для более быстрой обработки
  const BATCH_SIZE = 20;
  const allTagsData: GeneratedTagData[] = [];

  for (let i = 0; i < ALL_TAGS.length; i += BATCH_SIZE) {
    const batch = ALL_TAGS.slice(i, i + BATCH_SIZE);
    const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(ALL_TAGS.length / BATCH_SIZE);

    console.log(`🔄 Обрабатываем батч ${batchNumber}/${totalBatches} (${batch.length} тегов)`);

    try {
      const batchData = await generateTagsBatch(batch);
      allTagsData.push(...batchData);
      console.log(`✅ Батч ${batchNumber} завершен, получено ${batchData.length} тегов`);

      // Небольшая пауза между батчами чтобы не перегружать OpenAI
      if (i + BATCH_SIZE < ALL_TAGS.length) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      console.error(`❌ Ошибка в батче ${batchNumber}:`, error);
      // Продолжаем с следующим батчем
    }
  }

  console.log(`✅ Всего сгенерировано метаданных: ${allTagsData.length}/${ALL_TAGS.length}`);
  return allTagsData;
}

/**
 * Generate metadata for a batch of tags
 */
async function generateTagsBatch(tags: readonly string[]): Promise<GeneratedTagData[]> {
  const systemPrompt =
    `You are a nutrition and UX expert designing food tags for a nutrition tracking app.

Generate metadata for each tag in the provided list. For each tag:

1. **Labels**: Create user-friendly display names
   - English: Clear, appetizing, user-friendly (max 20 chars)
   - Russian: Natural Russian translation (max 20 chars)

2. **Colors**: Follow this design system color palette
   - Background colors should be PASTEL and MUTED versions of the reference colors
   - Text colors should be DARKER versions of the same hue for good contrast
   - Use varied but harmonious colors that work together

3. **Group**: Categorize into logical groups:
   - "nutrition" (protein, vitamins, etc.)
   - "dietary" (vegetarian, gluten-free, etc.)
   - "meal_time" (breakfast, snack, etc.)
   - "convenience" (quick, easy, etc.)
   - "preferences" (taste preferences, dislikes)
   - "type" (meal types, comfort food, etc.)

DESIGN SYSTEM COLOR INSPIRATION:
- Warm coral/salmon tones: #ff696b family
- Deep teal/green tones: #1a5c5a family  
- Cream/beige tones: #f8f0e3 family
- Sage/olive tones: #999a7b family
- Golden/orange tones: #f5b343 family
- Mint/aqua tones: #34b28b family
- Warm yellow tones: #f6c94a family

COLOR RULES:
- Background: Use pastel, muted versions (lighter, less saturated)
- Text: Use darker versions of the same hue family for contrast
- Vary the colors but keep them harmonious and in the same style
- Avoid bright, neon, or overly saturated colors
- Each tag should have a unique color combination

EXAMPLES:
- For protein tags: Light sage green background (#e8f0e8) with dark green text (#2d5530)
- For fruit tags: Light coral background (#ffe5e6) with dark coral text (#b8383a)
- For grain tags: Light cream background (#faf6ed) with dark brown text (#6b5d42)

Return JSON array with this exact structure:
[
  {
    "name": "tag_name",
    "labels": {
      "en": "Display Name",
      "ru": "Отображаемое имя"
    },
    "bg_color": "#HEXCODE",
    "text_color": "#HEXCODE",
    "group": "group_name"
  }
]

Make each tag visually distinct while maintaining design harmony.`;

  const messages = [
    textMsg("developer", systemPrompt),
    textMsg("user", `Generate metadata for these tags:\n${tags.join(", ")}`),
  ];

  const {text: responseText, usage} = await callOpenAI({
    model: process.env.OPENAI_MODEL || "gpt-5-mini",
    messages,
    responseFormat: "json_object",
    reasoningEffort: "low",
  });
  if (usage) {
    console.log("🧮 Tokens:", {
      prompt: usage.prompt_tokens,
      completion: usage.completion_tokens,
      total: usage.total_tokens,
    });
  }
  const tagsData = JSON.parse(responseText) as GeneratedTagData[];

  if (!Array.isArray(tagsData)) {
    throw new Error("Response is not an array");
  }

  return tagsData;
}

/**
 * Reset all existing tags to isGenerated: false
 */
async function resetExistingTags(): Promise<void> {
  console.log("🔄 Сбрасываем isGenerated для всех существующих тегов...");

  try {
    const existingTagsSnap = await db.collection(COLLECTIONS.TAGS).get();

    const batch = db.batch();
    let count = 0;

    existingTagsSnap.docs.forEach((doc) => {
      batch.update(doc.ref, {
        isGenerated: false,
        updated_time: admin.firestore.Timestamp.now(),
      });
      count++;
    });

    await batch.commit();
    console.log(`✅ Обновлено ${count} существующих тегов (isGenerated: false)`);
  } catch (error) {
    console.error("❌ Ошибка сброса существующих тегов:", error);
    throw error;
  }
}

/**
 * Save generated tags to Firestore
 */
async function saveTagsToFirestore(tagsData: GeneratedTagData[]): Promise<void> {
  console.log("💾 Сохраняем сгенерированные теги в Firestore...");

  const batch = db.batch();
  let savedCount = 0;
  let updatedCount = 0;

  for (const tagData of tagsData) {
    try {
      // Проверяем, существует ли тег
      const existingTagSnap = await db
        .collection(COLLECTIONS.TAGS)
        .where("name", "==", tagData.name)
        .limit(1)
        .get();

      if (existingTagSnap.empty) {
        // Создаем новый тег
        const newTagRef = db.collection(COLLECTIONS.TAGS).doc();
        const newTag: Tag = {
          ...tagData,
          isGenerated: false, // Пока не генерировали блюда для этого тега
          created_time: admin.firestore.Timestamp.now(),
        };
        batch.set(newTagRef, newTag);
        savedCount++;
      } else {
        // Обновляем существующий тег
        const existingTagRef = existingTagSnap.docs[0].ref;
        batch.update(existingTagRef, {
          labels: tagData.labels,
          bg_color: tagData.bg_color,
          text_color: tagData.text_color,
          group: tagData.group,
          updated_time: admin.firestore.Timestamp.now(),
        });
        updatedCount++;
      }
    } catch (error) {
      console.error(`❌ Ошибка обработки тега ${tagData.name}:`, error);
    }
  }

  await batch.commit();
  console.log(`✅ Сохранено новых тегов: ${savedCount}, обновлено: ${updatedCount}`);
}

/**
 * Main function to generate and save all tags (including updating existing ones)
 */
export async function generateAllTags(): Promise<void> {
  console.log("🎨 Запуск полной генерации/обновления всех тегов...");

  try {
    // 1. Сбрасываем isGenerated для существующих тегов
    await resetExistingTags();

    // 2. Генерируем метаданные для ВСЕХ тегов (включая существующие)
    const tagsData = await generateTagsMetadata();

    // 3. Сохраняем/обновляем в Firestore
    await saveTagsToFirestore(tagsData);

    console.log("✅ Полная генерация/обновление тегов завершена успешно!");
  } catch (error) {
    console.error("❌ Ошибка в generateAllTags:", error);
    throw error;
  }
}

/**
 * Generate tags for missing ones only (incremental update)
 */
export async function generateMissingTags(): Promise<void> {
  console.log("🔍 Поиск отсутствующих тегов...");

  try {
    // Получаем все существующие теги
    const existingTagsSnap = await db.collection(COLLECTIONS.TAGS).get();
    const existingTagNames = existingTagsSnap.docs.map((doc) => doc.data().name);

    // Находим отсутствующие теги
    const missingTags = ALL_TAGS.filter((tag) => !existingTagNames.includes(tag));

    if (missingTags.length === 0) {
      console.log("✅ Все теги уже существуют в базе");
      return;
    }

    console.log(
      `📝 Найдено ${missingTags.length} отсутствующих тегов:`,
      missingTags
    );

    // Генерируем метаданные только для отсутствующих тегов
    const systemPrompt =
      `You are a nutrition and UX expert designing food tags for a nutrition tracking app.

Generate metadata only for the provided missing tags. Use the same format and guidelines as before.

Return JSON array with this exact structure:
[
  {
    "name": "tag_name",
    "labels": {
      "en": "Display Name",
      "ru": "Отображаемое имя"
    },
    "bg_color": "#HEXCODE",
    "text_color": "#HEXCODE",
    "group": "group_name"
  }
]`;

    const messages = [
      textMsg("developer", systemPrompt),
      textMsg(
        "user",
        `Generate metadata for these missing tags:\n${missingTags.join(", ")}`
      ),
    ];

    const {text: responseText, usage} = await callOpenAI({
      model: process.env.OPENAI_MODEL || "gpt-5-mini",
      messages,
      responseFormat: "json_object",
      reasoningEffort: "low",
    });
    if (usage) {
      console.log("🧮 Tokens:", {
        prompt: usage.prompt_tokens,
        completion: usage.completion_tokens,
        total: usage.total_tokens,
      });
    }
    const missingTagsData = JSON.parse(responseText) as GeneratedTagData[];

    // Сохраняем только отсутствующие теги
    await saveTagsToFirestore(missingTagsData);

    console.log("✅ Генерация отсутствующих тегов завершена!");
  } catch (error) {
    console.error("❌ Ошибка в generateMissingTags:", error);
    throw error;
  }
}
