import { t } from '../../../src/lib/i18n';
import type { ChatCard } from '../lib/types';

/**
 * A card inside the message stream: a product, an order, or anything else a
 * public.rwp_chat_card_<type> function describes.
 *
 * Nothing here computes or formats a price from its parts. The amount, the currency and whether
 * the item is on sale all come from SQL (rwp_chat_card_product calls shop_effective_price, the
 * same function the catalogue uses), so a card can never advertise a price checkout will refuse.
 * This file only decides how to draw what it was given.
 *
 * It deliberately does not import anything from rwp-shop: the chat plugin must work on a site
 * with no shop, and one plugin never reaches into another's code.
 */

const money = (amount: number | string | null | undefined, currency: string | undefined): string => {
  const value = Number(amount);
  if (!Number.isFinite(value)) return '';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format(value);
  } catch {
    // An unknown currency code must not blank the card.
    return `${value.toFixed(2)} ${currency || ''}`.trim();
  }
};

interface ProductCardMessageProps {
  card: ChatCard;
  /** Adds the card's item to the cart without leaving the conversation. */
  onAddToCart?: (productId: string) => void;
}

export default function ProductCardMessage({ card, onAddToCart }: ProductCardMessageProps) {
  if (card.kind === 'order') return <OrderCard card={card} />;

  const price = money(card.price, card.currency);
  const wasPrice = card.on_sale ? money(card.regular_price, card.currency) : '';
  const outOfStock = card.stock_status === 'outofstock';

  return (
    <div className="rwp-chat-card">
      {card.image && <img className="rwp-chat-card-image" src={card.image} alt="" loading="lazy" />}
      <div className="rwp-chat-card-body">
        <a className="rwp-chat-card-title" href={card.url || '#'}>{card.title || t('chat.card.untitled', 'Untitled')}</a>
        {card.excerpt && <p className="rwp-chat-card-excerpt">{card.excerpt}</p>}
        {price && (
          <p className="rwp-chat-card-price">
            {price}
            {wasPrice && <span className="rwp-chat-card-was">{wasPrice}</span>}
          </p>
        )}
        {outOfStock && <p className="rwp-chat-card-out">{t('chat.card.out_of_stock', 'Out of stock')}</p>}
        <div className="rwp-chat-card-actions">
          {card.url && (
            <a className="rwp-chat-card-button rwp-chat-card-button-ghost" href={card.url}>
              {t('chat.card.view', 'View')}
            </a>
          )}
          {/* Variable products need options chosen, so SQL sets purchasable=false and the card
              links to the page instead of pretending one click is enough. */}
          {card.purchasable && card.product_id && onAddToCart && (
            <button type="button" className="rwp-chat-card-button" onClick={() => onAddToCart(String(card.product_id))}>
              {t('chat.card.add_to_cart', 'Add to cart')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const orderStatusLabels: Record<string, string> = {
  pending: 'Awaiting payment',
  processing: 'Being prepared',
  'on-hold': 'On hold',
  completed: 'Completed',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
  failed: 'Payment failed',
};

function OrderCard({ card }: { card: ChatCard }) {
  const status = String(card.status || '');
  const items = Array.isArray(card.items) ? (card.items as Array<{ name: string; quantity: number }>) : [];
  return (
    <div className="rwp-chat-card">
      <div className="rwp-chat-card-body">
        <strong className="rwp-chat-card-title">
          {t('chat.order.heading', 'Order #{id}', { id: String(card.id ?? '') })}
        </strong>
        <p className="rwp-chat-card-price">
          {t(`chat.order.status.${status}`, orderStatusLabels[status] || status)}
        </p>
        <div className="rwp-chat-order-rows">
          {items.slice(0, 5).map((item, index) => (
            <span key={`${item.name}-${index}`}>{item.quantity} × {item.name}</span>
          ))}
          {items.length > 5 && <span>{t('chat.order.more', '+{count} more', { count: items.length - 5 })}</span>}
        </div>
        <div className="rwp-chat-card-actions">
          {card.url && (
            <a className="rwp-chat-card-button rwp-chat-card-button-ghost" href={String(card.url)}>
              {t('chat.order.view', 'Open the order')}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
