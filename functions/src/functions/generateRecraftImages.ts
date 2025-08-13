import {db} from "../firebase";
import {generateRecraftFoodImage, markMealImageFailed} from "../utils/recraftImageGeneration";
import * as admin from "firebase-admin";

// Добавляем состояние пагинации: храним последний просмотренный документ
const STATE_REF = db.collection("internal").doc("recraft_image_generation_state");

type RecraftScanState = {
  lastDocId?: string | null;
  // было: started_at?: FirebaseFirestore.Timestamp;
  started_at?: admin.firestore.Timestamp;
  finished?: boolean;
};

// Минимальный набор полей блюда, необходимых для перегенерации изображения
type MinimalMeal = {
  id: string;
  title?: string;
  title_localized?: { en?: string };
  description_localized?: { en?: string };
  comment?: string;
  meal_type?: string;
  tags?: string[];
  image_generation_source?: string;
};

/**
 * Нормализует meal_type к одному из поддерживаемых значений генератора.
 */
function normalizeMealType(t?: string): "full_meal" | "snack" | "drink" {
  return t === "snack" || t === "drink" ? t : "full_meal";
}

/**
 * Получить состояние пагинации
 */
async function getScanState(): Promise<RecraftScanState> {
  const snap = await STATE_REF.get();
  return (snap.exists ? (snap.data() as RecraftScanState) : {}) || {};
}

/**
 * Обновить состояние пагинации
 */
async function setScanState(patch: Partial<RecraftScanState>): Promise<void> {
  await STATE_REF.set(
    {
      ...patch,
      updated_at: admin.firestore.Timestamp.now(),
    },
    {merge: true},
  );
}

/**
 * Сбросить курсор (начать проход с начала коллекции)
 */
export async function resetRecraftScanCursor(): Promise<void> {
  await STATE_REF.set(
    {
      lastDocId: null,
      finished: false,
      started_at: admin.firestore.Timestamp.now(),
      updated_at: admin.firestore.Timestamp.now(),
    },
    {merge: true},
  );
  console.log("🔄 Курсор сканирования Recraft сброшен");
}

/**
 * Debug function: check image generation status in meals
 */
export async function debugMealPhotos(): Promise<void> {
  console.log("🔍 Анализируем статус генерации изображений в блюдах...");

  try {
    // Проверяем первые 10 блюд
    const snapshot = await db
      .collection("generated_meals")
      .limit(10)
      .get();

    if (snapshot.empty) {
      console.log("📭 Блюда не найдены");
      return;
    }

    snapshot.docs.forEach((doc, index) => {
      const data = doc.data();
      console.log(`${index + 1}. ID: ${doc.id}`);
      console.log(`   Title: ${data.title}`);
      console.log(`   Has photo: ${!!data.photo}`);
      console.log(`   Image source: ${data.image_generation_source || "не указан"}`);
      console.log(`   Is compressed: ${data.image_compressed || false}`);
      console.log(`   Has title_localized: ${!!data.title_localized}`);
      console.log(`   Has description_localized: ${!!data.description_localized}`);
      console.log(`   Image generation failed: ${data.image_generation_failed || false}`);
      console.log("---");
    });

    // Подсчитываем статистику
    const totalMeals = snapshot.docs.length;
    const recraftGenerated = snapshot.docs.filter((doc) =>
      doc.data().image_generation_source === "recraft-v3"
    );
    const needsRegeneration = snapshot.docs.filter((doc) => {
      const data = doc.data();
      return data.image_generation_source !== "recraft-v3" && !data.image_generation_failed;
    });
    const withEnglishData = snapshot.docs.filter((doc) => {
      const data = doc.data();
      return data.title_localized?.en && data.description_localized?.en;
    });

    console.log(`📊 Статистика из ${totalMeals} блюд:`);
    console.log(`   Уже обработаны Recraft: ${recraftGenerated.length}`);
    console.log(`   Требуют перегенерации: ${needsRegeneration.length}`);
    console.log(`   С английскими данными: ${withEnglishData.length}`);
  } catch (error) {
    console.error("❌ Ошибка анализа блюд:", error);
  }
}

/**
 * Test function: regenerate image for first meal not processed by Recraft
 */
export async function generateSingleTestImage(): Promise<void> {
  console.log("🧪 Ищем первое блюдо для перегенерации изображения с Recraft...");

  try {
    // Упрощенный запрос - просто берем блюда без фильтров !=
    const mealsQuery = db
      .collection("generated_meals")
      .limit(50); // Берем больше для фильтрации в коде

    const snapshot = await mealsQuery.get();

    if (snapshot.empty) {
      console.log("📭 Блюда не найдены");
      return;
    }

    // Фильтруем в коде блюда, которые требуют перегенерации (включая ранее упавшие)
    const needRegenerationDocs = snapshot.docs.filter((doc) => {
      const data = doc.data();
      const needsRegeneration = data.image_generation_source !== "recraft-v3";
      const hasEnglishData = data.title_localized?.en && data.description_localized?.en;

      // Не пропускаем ранее упавшие: повторяем попытку
      return needsRegeneration && (hasEnglishData || data.title);
    });

    if (needRegenerationDocs.length === 0) {
      console.log("📭 Все блюда уже обработаны Recraft'ом или имеют ошибки");
      console.log("🔍 Запускаем анализ структуры данных...");
      await debugMealPhotos();
      return;
    }

    console.log(`✅ Найдено ${needRegenerationDocs.length} блюд для перегенерации`);

    // Берем первое подходящее блюдо
    const doc = needRegenerationDocs[0];
    const meal: MinimalMeal = {id: doc.id, ...(doc.data() as Partial<MinimalMeal>)};

    console.log(`🎯 Выбрано блюдо для перегенерации: ${meal.title} (ID: ${meal.id})`);
    console.log(`🔄 Текущий источник изображения: ${meal.image_generation_source || "не указан"}`);

    // Извлекаем английские тексты (с fallback на русские)
    const englishTitle = meal.title_localized?.en || meal.title;
    const englishDescription = meal.description_localized?.en ||
                              meal.comment ||
                              `A delicious ${meal.title}`;

    if (!englishTitle) {
      console.log(`⚠️ Блюдо ${meal.title} не имеет заголовка, пропускаем`);
      return;
    }

    if (!meal.id) {
      console.log(`⚠️ Блюдо ${meal.title} не имеет ID, пропускаем`);
      return;
    }

    console.log(`🎨 Начинаем перегенерацию изображения для: ${englishTitle}`);
    console.log(`📝 Описание: ${englishDescription}`);

    const result = await generateRecraftFoodImage({
      englishTitle,
      englishDescription,
      mealType: normalizeMealType(meal.meal_type),
      tags: meal.tags || [],
    });

    // Обновляем документ с новым фото и флагами
    await db.collection("generated_meals").doc(meal.id).update({
      photo: result.photoUrl,
      blurhash: result.blurhash,
      image_generated_at: admin.firestore.Timestamp.now(),
      image_generation_source: "recraft-v3", // Помечаем как обработанное Recraft'ом!
      image_compressed: true,
      previous_photo_regenerated: true, // Дополнительный флаг
      // Сбрасываем флаги ошибки после успешной генерации
      image_generation_failed: false,
      image_generation_error: admin.firestore.FieldValue.delete(),
      image_generation_failed_at: admin.firestore.FieldValue.delete(),
    });

    console.log("✅ ПЕРЕГЕНЕРАЦИЯ УСПЕШНА! Новое изображение сохранено:");
    console.log(`🔗 Photo URL: ${result.photoUrl}`);
    console.log(`🎨 Blurhash: ${result.blurhash}`);
    console.log(`🍽️ Блюдо: ${meal.title}`);
    console.log(`🆔 ID: ${meal.id}`);
  } catch (error) {
    console.error("❌ Ошибка перегенерации изображения:", error);
    throw error;
  }
}

/**
 * Process batch of meals for image regeneration
 */
export async function generateImagesBatch(): Promise<{
  processed: number;
  generated: number;
  failed: number;
  hasMore: boolean;
}> {
  const BATCH_SIZE = 10;
  const SCAN_PAGE_SIZE = 200;

  console.log(`📦 Перегенерация изображений: batch=${BATCH_SIZE}, scanPage=${SCAN_PAGE_SIZE}`);

  try {
    // 1) Загружаем состояние курсора
    const state = await getScanState();
    const lastDocId = state.lastDocId || null;

    // 2) Строим запрос (убрали лишние касты типов)
    let query = db
      .collection("generated_meals")
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(SCAN_PAGE_SIZE);

    if (lastDocId) {
      query = query.startAfter(lastDocId);
      console.log(`➡️ Продолжаем после docId=${lastDocId}`);
    } else {
      console.log("🏁 Начинаем скан коллекции с начала");
    }

    const snapshot = await query.get();

    if (snapshot.empty) {
      // Дошли до конца коллекции — сбрасываем курсор и считаем, что больше страниц нет
      await setScanState({lastDocId: null, finished: true});
      console.log("✅ Конец коллекции. Все страницы просмотрены. Курсор сброшен.");
      return {processed: 0, generated: 0, failed: 0, hasMore: false};
    }

    const pageDocCount = snapshot.docs.length;
    const lastDocOnPage = snapshot.docs[pageDocCount - 1];
    if (!lastDocOnPage) {
      // Теоретически недостижимо, т.к. snapshot.empty проверен выше,
      // но оставим защиту для линтера и на всякий случай.
      await setScanState({lastDocId: null, finished: true});
      console.log("⚠️ На странице нет документов, завершаем сканирование.");
      return {processed: 0, generated: 0, failed: 0, hasMore: false};
    }
    const lastDocOnPageId = lastDocOnPage.id;
    const pageHasMore = pageDocCount === SCAN_PAGE_SIZE;

    console.log(`🔍 Прочитано документов: ${pageDocCount}. Последний на странице: ${lastDocOnPageId}`);

    // 3) Фильтруем на стороне приложения тех, кто требует перегенерации (включая ранее упавшие)
    const candidates = snapshot.docs.filter((doc) => {
      const data = doc.data();
      const needsRegeneration = data.image_generation_source !== "recraft-v3";
      const hasData = data.title_localized?.en || data.title;
      // Не пропускаем ранее упавшие: повторяем попытку
      return needsRegeneration && hasData;
    });

    if (candidates.length === 0) {
      // На этой странице нет кандидатов — продвигаем курсор и продолжаем в следующий раз
      await setScanState({lastDocId: lastDocOnPageId, finished: !pageHasMore});
      console.log("📭 На текущей странице кандидатов нет. Продвинулся по курсору.");
      return {
        processed: 0,
        generated: 0,
        failed: 0,
        hasMore: pageHasMore, // ещё есть страницы — продолжим в следующий запуск
      };
    }

    // 4) Берём максимум BATCH_SIZE кандидатов и обрабатываем
    const toProcess = candidates.slice(0, BATCH_SIZE);
    console.log(`📊 Кандидатов на странице: ${candidates.length}. Обрабатываем: ${toProcess.length}`);

    let processedCount = 0;
    let generatedCount = 0;
    let failedCount = 0;

    for (const doc of toProcess) {
      // Явно типизируем только нужные поля, без зависимости от внешних типов
      const data = doc.data() as Partial<MinimalMeal>;
      const meal: MinimalMeal = {id: doc.id, ...data};
      processedCount++;

      if (!meal.id) {
        console.log(`⚠️ Блюдо ${meal.title} без ID — пропуск`);
        continue;
      }

      try {
        const englishTitle = meal.title_localized?.en || meal.title;
        const englishDescription =
          meal.description_localized?.en || meal.comment || `A delicious ${meal.title}`;
        if (!englishTitle) {
          console.log(`⚠️ ${meal.title} без заголовка — пропуск`);
          continue;
        }

        console.log(
          `🎨 ${processedCount}/${toProcess.length} Перегенерация: ${englishTitle} (old src: ` +
          `${meal.image_generation_source || "n/a"})`
        );

        const result = await generateRecraftFoodImage({
          englishTitle,
          englishDescription,
          mealType: normalizeMealType(meal.meal_type),
          tags: meal.tags || [],
        });

        await db.collection("generated_meals").doc(meal.id).update({
          photo: result.photoUrl,
          blurhash: result.blurhash,
          image_generated_at: admin.firestore.Timestamp.now(),
          image_generation_source: "recraft-v3",
          image_compressed: true,
          previous_photo_regenerated: true,
          updated_time: admin.firestore.Timestamp.now(),
          // Сбрасываем флаги ошибки после успешной генерации
          image_generation_failed: false,
          image_generation_error: admin.firestore.FieldValue.delete(),
          image_generation_failed_at: admin.firestore.FieldValue.delete(),
        });

        generatedCount++;
        console.log(`✅ Перегенерировано: ${meal.title} -> ${result.photoUrl}`);

        // Лёгкая пауза между запросами
        await new Promise((r) => setTimeout(r, 500));
      } catch (error) {
        failedCount++;
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        console.error(`❌ Ошибка перегенерации для ${meal.title}: ${errorMessage}`);
        await markMealImageFailed(meal.id, errorMessage);
      }
    }

    // 5) Продвигаем курсор на последний документ страницы, чтобы скан шёл вперёд
    await setScanState({lastDocId: lastDocOnPageId, finished: !pageHasMore});

    const logMessage =
      `📊 Батч: просмотрено=${pageDocCount}, обработано=${processedCount}, ` +
      `перегенерировано=${generatedCount}, ошибок=${failedCount}, hasMore=${pageHasMore}`;
    console.log(logMessage);

    return {
      processed: processedCount,
      generated: generatedCount,
      failed: failedCount,
      hasMore: pageHasMore, // основано на размере страницы, а не на count кандидатов
    };
  } catch (error) {
    console.error("❌ Ошибка обработки батча перегенерации:", error);
    throw error;
  }
}
