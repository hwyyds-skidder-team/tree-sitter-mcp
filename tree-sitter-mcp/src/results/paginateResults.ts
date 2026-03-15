import { z } from "zod";

export const PaginationSchema = z.object({
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  nextOffset: z.number().int().nonnegative().nullable(),
});

export type Pagination = z.infer<typeof PaginationSchema>;

interface PaginateResultsOptions {
  limit?: number;
  offset?: number;
}

export interface PaginatedResults<T> {
  items: T[];
  pagination: Pagination;
}

export function paginateResults<T>(
  items: readonly T[],
  options: PaginateResultsOptions = {},
): PaginatedResults<T> {
  const limit = options.limit ?? 50;
  const offset = Math.max(0, options.offset ?? 0);
  const pagedItems = items.slice(offset, offset + limit);
  const nextOffset = offset + pagedItems.length;
  const hasMore = nextOffset < items.length;

  return {
    items: [...pagedItems],
    pagination: PaginationSchema.parse({
      limit,
      offset,
      returned: pagedItems.length,
      total: items.length,
      hasMore,
      nextOffset: hasMore ? nextOffset : null,
    }),
  };
}
