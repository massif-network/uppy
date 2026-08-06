export type CanonicalSourceVersionInput = {
  canonicalUri: string
  serial: number
  lastUpdated: string
  size: number
  archivedMd5: string | null | undefined
}

export const getCanonicalSourceVersion = ({
  canonicalUri,
  serial,
  lastUpdated,
  size,
  archivedMd5,
}: CanonicalSourceVersionInput): string =>
  `${canonicalUri}|${serial}|${lastUpdated}|${size}${
    archivedMd5 ? `|${archivedMd5}` : ''
  }`
