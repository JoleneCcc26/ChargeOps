export function paginationFrom(query, { defaultPageSize = 100, maxPageSize = 500 } = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const pageSize = Math.min(
    maxPageSize,
    Math.max(1, Number.parseInt(query.pageSize ?? query.limit, 10) || defaultPageSize)
  );
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function setPaginationHeaders(res, { page, pageSize }, total) {
  res.setHeader("X-Total-Count", String(total));
  res.setHeader("X-Page", String(page));
  res.setHeader("X-Page-Size", String(pageSize));
  res.setHeader("X-Total-Pages", String(total === 0 ? 0 : Math.ceil(total / pageSize)));
}

