// Fixtures partagees pour les tests E2E de review.html : une lecon minimale
// avec 2 phrases / 4 mots — juste assez pour rendre des <span class="w">
// cliquables et un crayon ✏️ (+ badge data-si-badge) par phrase.
export const WORDS = [
  { word: 'Bonjour', sentenceIndex: 0, start: 0, end: 0.5 },
  { word: 'monde', sentenceIndex: 0, start: 0.5, end: 1.0 },
  { word: 'deuxieme', sentenceIndex: 1, start: 1.0, end: 1.5 },
  { word: 'phrase', sentenceIndex: 1, start: 1.5, end: 2.0 },
];

export const LESSON = {
  lesson_key: 'demo/module-01/01-demo',
  course_id: 'demo',
  title: 'Lecon demo',
  short_title: 'Demo',
  duration_seconds: 2,
};
