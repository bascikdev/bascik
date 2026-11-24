export interface Book {
  title: string;
  author: string;
  rating: string;
  pages: number;
  year: number;
  mood: string;
  blurb: string;
}

export const BOOKS: Book[] = [
  {
    title: "Refactoring the Monolith",
    author: "Grace Lin",
    rating: "4.7",
    pages: 412,
    year: 2023,
    mood: "practical",
    blurb: "A field guide to splitting a large system without stopping it.",
  },
  {
    title: "Practical Type Systems",
    author: "Ada Okafor",
    rating: "4.5",
    pages: 288,
    year: 2024,
    mood: "deep",
    blurb: "Types as a design tool, explained through real programs.",
  },
  {
    title: "Shipping Small Changes",
    author: "Sam Rivera",
    rating: "4.8",
    pages: 196,
    year: 2022,
    mood: "short",
    blurb: "Why small releases win, and how a team gets there.",
  },
  {
    title: "The Quiet Network",
    author: "Mina Park",
    rating: "4.3",
    pages: 344,
    year: 2021,
    mood: "story",
    blurb: "A novel about the people who keep the internet running at night.",
  },
];

export const findBook = (text: string): Book | undefined => {
  const wanted = text.toLowerCase();
  return BOOKS.find((book) => wanted.includes(book.title.toLowerCase()));
};
