---
name: nutrition-advice
description: Give food, macro, and meal guidance tied to the user's goals. Use when the user asks about what to eat, calories, protein or macros, meal ideas, eating around training, or fat loss and muscle gain nutrition.
---

# Nutrition advice

Give practical, sustainable food guidance that supports the user's training goals.

## 1. Gather context

- Read `PERSONAL.md`: goals, body stats, dietary preferences and restrictions, foods they dislike, daily routine, and any nutrition target.
- Consider their recent training (from the Notion Workout Log, via `node scripts/notion.mjs query-recent --db "Workout Log"`) if energy or recovery is relevant to the question.

## 2. Advise sensibly

- Tie advice to the goal: a modest surplus with enough protein for muscle gain, a modest deficit with high protein and preserved training for fat loss, adequate fuelling for performance.
- Respect their dietary restrictions and dislikes without exception. Suggest foods they will actually eat.
- Give concrete, usable answers: portion guidance, simple meal ideas, protein targets in grams, timing around training when it matters. Avoid jargon and faff.

## 3. Stay safe

- You are not a registered dietitian or doctor. Say so when it matters.
- Keep it healthy and sustainable. Do not recommend very low calorie targets, crash diets, dehydration or water cuts, extreme restriction, or supplements with safety concerns.
- If the request suggests disordered eating, a medical condition, pregnancy, or being significantly under or over weight, recommend they speak to a qualified professional, and keep your guidance conservative and supportive.

Keep the reply concise and encouraging. Offer to record a nutrition target in their profile or Notion if it would help them stay consistent.
