// A card is an integer 0..51: rank = card % 13 (0 = Ace … 12 = King),
// suit = floor(card / 13). Plain numbers keep the game state JSON-friendly.

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const SUITS = ['♠', '♥', '♦', '♣'];
export const JACK = 10;

export const rank = card => card % 13;
export const suit = card => Math.floor(card / 13);
export const value = card => Math.min(rank(card) + 1, 10);
export const isRed = card => suit(card) === 1 || suit(card) === 2;
export const cardName = card => RANKS[rank(card)] + SUITS[suit(card)];

export const sortCards = cards => [...cards].sort((a, b) => rank(a) - rank(b) || suit(a) - suit(b));

export function shuffledDeck(random = Math.random) {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// "5H", "10s", "JD" → card number. Used by the tests.
export function parseCard(text) {
  const match = /^(10|[A2-9JQK])([SHDC])$/i.exec(text.trim());
  if (!match) throw new Error(`Not a card: ${text}`);
  return 'SHDC'.indexOf(match[2].toUpperCase()) * 13 + RANKS.indexOf(match[1].toUpperCase());
}

export const parseCards = text => text.split(/\s+/).filter(Boolean).map(parseCard);
