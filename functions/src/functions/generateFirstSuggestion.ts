/**
 * Generate a first personalized nutrition suggestion for a new user.
 */
import {db} from "../firebase";
import {COLLECTIONS, User} from "../types/firestore";
import {generateSuggestionForUser} from "./generateSuggestions";

/**
 * Main entry point to generate and save a first-time suggestion.
 */
export async function generateFirstSuggestionFunction(
  userId: string,
  activeCalories: number,
  passiveCalories: number,
  locale: "en" | "ru",
): Promise<string> {
  // Проверяем существование пользователя
  const userDoc = await db.collection(COLLECTIONS.USERS).doc(userId).get();
  if (!userDoc.exists) {
    throw new Error("User not found");
  }

  const userData = userDoc.data() as User;
  const userEmail = userData.email || userId;

  console.log(
    `🎉 Генерируем первую рекомендацию для нового пользователя ${userEmail}`
  );

  // Устанавливаем язык пользователя и калории (если еще не установлены)
  await db.collection(COLLECTIONS.USERS).doc(userId).update({
    language: locale,
    active_calories: activeCalories,
    passive_calories: passiveCalories,
  });

  console.log(
    `⚙️ ${userEmail}: установлены калории ` +
    `(активные=${activeCalories}, пассивные=${passiveCalories}), язык=${locale}`
  );

  // Используем общую логику генерации с флагом первой рекомендации
  await generateSuggestionForUser(userId, true);

  // Получаем сохраненную рекомендацию
  const updatedUserDoc = await db.collection(COLLECTIONS.USERS).doc(userId).get();
  const updatedUserData = updatedUserDoc.data();
  const suggestion = updatedUserData?.suggestion ?? "Welcome to your nutrition journey!";

  const truncatedSuggestion = suggestion.length > 100 ?
    suggestion.slice(0, 100) + "..." :
    suggestion;
  console.log(
    `✅ ${userEmail}: первая рекомендация сохранена: "${truncatedSuggestion}"`
  );

  return suggestion;
}
