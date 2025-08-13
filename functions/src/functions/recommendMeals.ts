import {db} from "../firebase";
import {DocumentReference, DocumentData} from "firebase-admin/firestore";

interface RecommendMealsInput {
  userRef: DocumentReference<DocumentData>;
  timeOfDay: "morning" | "lunch" | "dinner";
  dailyNorm: {
    calories: number;
    proteins: number;
    fats: number;
    carbohydrates: number;
  };
  totalToday: {
    calories: number;
    proteins: number;
    fats: number;
    carbohydrates: number;
  };
  likedTags: string[];
}

interface GeneratedMeal {
  id: string;
  ref: DocumentReference<DocumentData>;
  title?: string;
  tags?: string[];
  calories: number;
  [key: string]: unknown;
}

/**
 * Recommend meals based on time of day, nutrient needs, user preferences and feedback.
 * Prioritizes meals with specific tags (breakfast/lunch/dinner/snack) and liked content.
 *
 * @param input - User info, nutritional norms, time of day and tags
 * @returns Array of DocumentReferences to suggested meals
 */
export async function recommendMeals(
  input: RecommendMealsInput
): Promise<DocumentReference<DocumentData>[]> {
  const {userRef, timeOfDay, dailyNorm, totalToday, likedTags} = input;

  let maxKcal = 500;
  let minKcal = 200;
  const ratio = totalToday.calories / dailyNorm.calories;

  if (timeOfDay === "morning") {
    if (ratio >= 0.3) {
      maxKcal = 150;
      minKcal = 50;
    } else {
      minKcal = 200;
      maxKcal = 400;
    }
  } else if (timeOfDay === "lunch") {
    if (ratio >= 0.6) {
      maxKcal = 300;
      minKcal = 100;
    } else {
      minKcal = 350;
      maxKcal = 600;
    }
  } else if (timeOfDay === "dinner") {
    if (ratio >= 0.9) {
      maxKcal = 200;
      minKcal = 50;
    } else {
      minKcal = 300;
      maxKcal = 500;
    }
  }

  const bRatio = totalToday.proteins / dailyNorm.proteins;
  const fRatio = totalToday.fats / dailyNorm.fats;
  const cRatio = totalToday.carbohydrates / dailyNorm.carbohydrates;

  const requiredTags: string[] = [];
  if (bRatio < 0.5) requiredTags.push("high_protein");
  if (cRatio < 0.5) requiredTags.push("vegetable", "high_fiber");
  if (fRatio > 0.8) requiredTags.push("low_fat");

  let primaryTag: "morning" | "lunch" | "dinner" | "snack" = timeOfDay;
  if (
    (timeOfDay === "morning" && ratio >= 0.3) ||
    (timeOfDay === "lunch" && ratio >= 0.6) ||
    (timeOfDay === "dinner" && ratio >= 0.9)
  ) {
    primaryTag = "snack";
  }

  const feedbackSnap = await db
    .collection("user_generated_meal_feedback")
    .where("user_ref", "==", userRef)
    .get();

  const likedMeals = feedbackSnap.docs
    .filter((d) => d.data().is_liked)
    .map((d) => d.data().generated_meal_ref.id);

  const dislikedMeals = feedbackSnap.docs
    .filter((d) => !d.data().is_liked)
    .map((d) => d.data().generated_meal_ref.id);

  const allMealsSnap = await db
    .collection("generated_meals")
    .where("calories", ">=", minKcal)
    .where("calories", "<=", maxKcal)
    .limit(100)
    .get();

  const allMealsRaw: GeneratedMeal[] = allMealsSnap.docs.map((d) => ({
    id: d.id,
    ref: d.ref,
    ...(d.data() as DocumentData),
  })) as GeneratedMeal[];

  const primaryMeals = allMealsRaw.filter((meal) =>
    meal.tags?.includes(primaryTag)
  );
  const fallbackMeals = allMealsRaw.filter(
    (meal) => !meal.tags?.includes(primaryTag)
  );
  const allMeals = [...primaryMeals, ...fallbackMeals];

  const likedSelection = allMeals
    .filter((m) => likedMeals.includes(m.id))
    .sort((a, b) => {
      const score = (tags: string[] = []) =>
        tags.filter((t) => [...requiredTags, ...likedTags].includes(t)).length;
      return score(b.tags) - score(a.tags);
    })
    .slice(0, 2);

  const newIdeasSelection = allMeals
    .filter(
      (m) => !likedMeals.includes(m.id) && !dislikedMeals.includes(m.id)
    )
    .sort((a, b) => {
      const score = (tags: string[] = []) =>
        tags.filter((t) => [...requiredTags, ...likedTags].includes(t)).length;
      return score(b.tags) - score(a.tags);
    })
    .slice(0, 3);

  while (likedSelection.length < 2) {
    const candidates = allMeals.filter(
      (m) =>
        !likedSelection.some((s) => s.id === m.id) &&
        !newIdeasSelection.some((s) => s.id === m.id) &&
        !dislikedMeals.includes(m.id)
    );
    if (!candidates.length) break;
    likedSelection.push(
      candidates[Math.floor(Math.random() * candidates.length)]
    );
  }

  while (likedSelection.length + newIdeasSelection.length < 5) {
    const candidates = allMeals.filter(
      (m) =>
        !likedSelection.some((s) => s.id === m.id) &&
        !newIdeasSelection.some((s) => s.id === m.id) &&
        !dislikedMeals.includes(m.id)
    );
    if (!candidates.length) break;
    newIdeasSelection.push(
      candidates[Math.floor(Math.random() * candidates.length)]
    );
  }

  return [...newIdeasSelection, ...likedSelection].map((m) => m.ref);
}
