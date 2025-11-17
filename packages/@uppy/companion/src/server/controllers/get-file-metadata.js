import { respondWithError } from '../provider/error.js'

export default async function getFileMetadata({ params, companion }, res, next) {
  const { providerUserSession } = companion
  try {
    const data = await companion.provider.getFileMetadata({
      companion,
      providerUserSession,
      fileId: params.id,
    })
    res.json(data)
  } catch (err) {
    if (respondWithError(err, res)) return
    next(err)
  }
}
