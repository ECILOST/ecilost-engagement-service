import { describe, expect, it, vi } from 'vitest';
import { NotificationsController } from './notifications.controller.js';

describe('NotificationsController', () => {
  it('solo devuelve las notificaciones de quien consulta, de la mas reciente a la mas vieja', async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: 'n1' }]);
    const controller = new NotificationsController({ notification: { findMany } } as never);

    await expect(controller.mine({ headers: {}, userId: 'alice' })).resolves.toEqual({ items: [{ id: 'n1' }] });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { recipientId: 'alice' }, orderBy: { createdAt: 'desc' } }));
  });

  it('marcar como leidas solo toca las no leidas de quien consulta', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const controller = new NotificationsController({ notification: { updateMany } } as never);

    await controller.markRead({ headers: {}, userId: 'alice' });
    expect(updateMany).toHaveBeenCalledWith({ where: { recipientId: 'alice', readAt: null }, data: { readAt: expect.any(Date) } });
  });
});
