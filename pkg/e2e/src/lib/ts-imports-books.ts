// Reached from <ts-imports> through the @/ alias (scripts.importRoot is src).
interface Book {
  title: string;
  author: string;
  rating: number;
}

const books: Book[] = [
  { title: "Parable of the Sower", author: "Octavia E. Butler", rating: 5 },
];

export const featuredBook = (): Book => books[0];
