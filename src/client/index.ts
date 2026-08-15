/**
 * dsh-assistant-message-forge — Client half.
 *
 * Contributes the "Message Forge" tab to the conversation-view ring. The tab
 * owns every button the testing workflow needs: add/edit/delete drafts,
 * inject one draft into the current session, and import + recognize an
 * uploaded session.jsonl(.zstd) so its assistant messages can be reused.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { ForgeView, type ForgeViewInjected } from './ForgeView.tsx'
import { en, zh } from './locales.ts'

export const name = 'dsh-assistant-message-forge-client'

export const inject = ['slots', 'locale', 'connection']

export const LOCALE_NS = 'assistantMessageForge'

/**
 * Client plugin body: locale dictionaries plus one session-scoped
 * `conversation.view` entry. Registration rides the slot service effect
 * wrapper, so plugin unload removes the tab again.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-assistant-message-forge: dictionaries')

  const t = ctx.locale.bind(LOCALE_NS)

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'assistant-message-forge',
    order: 20,
    locale: LOCALE_NS,
    label: () => t('tab.title'),
    inject: (_sessionId: SessionId): ForgeViewInjected => {
      const connection = ctx.get('connection') as ConnectionHandle | undefined
      if (connection === undefined) {
        throw new Error('dsh-assistant-message-forge: browser connection service is unavailable')
      }
      return { rpc: connection.rpc }
    },
  }, ForgeView))
}
