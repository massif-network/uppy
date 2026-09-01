import type { UnknownPlugin } from '@uppy/core'
import type {
  Body,
  CompanionClientProvider,
  CompanionClientSearchProvider,
  CompanionFile,
  Meta,
  UppyFileNonGhost,
} from '@uppy/utils'
import { getSafeFileId } from '@uppy/utils'
import companionFileToUppyFile from './companionFileToUppyFile.js'

export type AddFilesOptions = {
  /**
   * Suppress the "Added N files" / "Not adding N files" notices.
   *
   * A streaming walk calls this dozens of times for one user action; without
   * this the user would be buried in informational toasts for a selection they
   * made once. The single notice for the whole selection is emitted by the
   * caller when the walk finishes.
   */
  quiet?: boolean
  /** Receives the ids Uppy will have assigned to the files that were added. */
  onAdded?: (uppyFileIds: string[]) => void
}

const addFiles = <M extends Meta, B extends Body>(
  companionFiles: CompanionFile[],
  plugin: UnknownPlugin<M, B>,
  provider: CompanionClientProvider | CompanionClientSearchProvider,
  options: AddFilesOptions = {},
): void => {
  const uppyFiles = companionFiles.map((f) =>
    companionFileToUppyFile<M, B>(f, plugin, provider),
  )

  const filesToAdd: UppyFileNonGhost<M, B>[] = []
  const filesAlreadyAdded: UppyFileNonGhost<M, B>[] = []
  const idsToAdd: string[] = []
  uppyFiles.forEach((file) => {
    const id = getSafeFileId(file, plugin.uppy.getID())
    if (plugin.uppy.checkIfFileAlreadyExists(id)) {
      filesAlreadyAdded.push(file)
    } else {
      filesToAdd.push(file)
      idsToAdd.push(id)
    }
  })

  if (!options.quiet) {
    if (filesToAdd.length > 0) {
      plugin.uppy.info(
        plugin.uppy.i18n('addedNumFiles', { numFiles: filesToAdd.length }),
      )
    }
    if (filesAlreadyAdded.length > 0) {
      plugin.uppy.info(
        `Not adding ${filesAlreadyAdded.length} files because they already exist`,
      )
    }
  }
  plugin.uppy.addFiles(filesToAdd)
  // After the add, so a consumer that reacts to these ids can already find the
  // files on the Uppy instance.
  if (idsToAdd.length > 0) options.onAdded?.(idsToAdd)
}

export default addFiles
