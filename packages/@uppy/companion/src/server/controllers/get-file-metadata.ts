import type { NextFunction, Request, Response } from 'express'
import { respondWithError } from '../provider/error.js'

export default async function getFileMetadata(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { params, companion } = req
  const id = params['id']
  const { providerUserSession, provider } = companion
  if (!provider || typeof id !== 'string') {
    res.sendStatus(400)
    return
  }

  try {
    const data = await provider.getFileMetadata({
      companion,
      providerUserSession,
      fileId: id,
    })
    res.json(data)
  } catch (err) {
    if (respondWithError(err, res)) return
    next(err)
  }
}
