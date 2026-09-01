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
  /**
   * Receives the ids Uppy ACTUALLY took, read back from its state after the
   * add. Not the ids we offered: `uppy.addFiles` drops a file that fails a
   * restriction without throwing, so the two differ exactly when a caller most
   * needs to know — a count to report, or a set of ids to remove again.
   */
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
  // Two reasons land here, and the notice below has to be true of both: the
  // file is already on the instance, or an earlier entry in THIS batch already
  // claimed its id. Only the first is "already exists".
  const duplicateFiles: UppyFileNonGhost<M, B>[] = []
  const idsToAdd: string[] = []
  // Ids claimed by THIS batch. `checkIfFileAlreadyExists` only knows what is
  // already on the instance, so without this a batch holding the same file
  // twice — a provider repeating an item across a page boundary, say — hands
  // Uppy two entries for one key and then reports two as added.
  const claimed = new Set<string>()
  uppyFiles.forEach((file) => {
    const id = getSafeFileId(file, plugin.uppy.getID())
    if (claimed.has(id) || plugin.uppy.checkIfFileAlreadyExists(id)) {
      duplicateFiles.push(file)
      return
    }
    claimed.add(id)
    filesToAdd.push(file)
    idsToAdd.push(id)
  })

  if (!options.quiet) {
    if (filesToAdd.length > 0) {
      plugin.uppy.info(
        plugin.uppy.i18n('addedNumFiles', { numFiles: filesToAdd.length }),
      )
    }
    if (duplicateFiles.length > 0) {
      plugin.uppy.info(`Not adding ${duplicateFiles.length} duplicate files`)
    }
  }
  // `Uppy.addFiles([])` still clones the whole file set into a `setState` and
  // emits `files-added`, re-rendering every subscriber for no change. Reachable
  // with a non-empty argument too — every file in the batch having been
  // filtered out above is exactly what a re-served page looks like. Unreachable
  // for an EMPTY selection, which is what would otherwise notice the missing
  // event: `FooterActions` does not render the confirm button at all until
  // something is checked.
  if (filesToAdd.length > 0) plugin.uppy.addFiles(filesToAdd)
  // Read back after the add, so a consumer reacting to these ids can find every
  // one of them on the instance — and so a restriction failure narrows the list
  // instead of silently inflating it.
  options.onAdded?.(idsToAdd.filter((id) => plugin.uppy.getFile(id) != null))
}

export default addFiles
