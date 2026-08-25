/**
 * TypeScript's bundled DOM lib already declares FileSystemHandle,
 * FileSystemDirectoryHandle, and FileSystemFileHandle (from the drag-and-drop
 * spec — DataTransferItem.getAsFileSystemHandle()), including name/kind/
 * getFileHandle/getDirectoryHandle/getFile/createWritable. What it's missing
 * is the permission-management half of the File System Access spec itself
 * (queryPermission/requestPermission) and Window.showDirectoryPicker, since
 * those aren't part of the drag-and-drop spec TS already covers. This fills
 * in just that gap via declaration merging, rather than pulling in
 * @types/wicg-file-system-access for a handful of signatures.
 */
export {}

declare global {
  interface FileSystemHandlePermissionDescriptor {
    mode?: 'read' | 'readwrite'
  }

  interface FileSystemHandle {
    queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
    requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
  }

  interface Window {
    showDirectoryPicker(options?: { id?: string; mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>
  }
}
