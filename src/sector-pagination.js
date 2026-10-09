/** Pure bounded pagination. No sector is hidden behind completion requirements. */
export const SECTORS_PER_PAGE=9;
export function sectorPageBounds(count,page=0){
  const total=Math.max(0,Number.isFinite(count)?Math.floor(count):0);
  const pages=Math.ceil(total/SECTORS_PER_PAGE);
  const selected=Math.max(0,Math.min(Math.max(0,pages-1),Number.isFinite(page)?Math.floor(page):0));
  const start=selected*SECTORS_PER_PAGE;
  return {page:selected,pages,start,end:Math.min(total,start+SECTORS_PER_PAGE),total};
}
