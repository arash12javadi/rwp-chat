import { loadSettings } from '../../../src/lib/settings';
import { uploadToCloudinary } from '../../../src/lib/uploads';
import { pluginMediaFolder } from '../../../src/lib/mediaScope';
import { CHAT_MEDIA_FOLDER } from '../../../src/lib/mediaFolders';
import { callChatServer, ChatEndpointUnavailableError } from './api';
import type { ChatAttachment, ChatCredentials } from './types';

/**
 * Attachments a visitor sends in the chat.
 *
 * Two folders are involved and they are not the same thing (see src/lib/mediaScope.js):
 *
 *   provider folder   plugins/rwp-chat/chat_media   fixed at upload time, what deletes key off
 *   library folder    chat_media                    the media.folder column, shown in the admin
 *
 * The provider folder has to stay under plugins/rwp-chat/ or uninstalling the plugin could never
 * clean these files up — and the media prefix check in readMediaPrefixes would refuse the
 * manifest if it claimed anything else. The library folder is the flat "chat_media" the Media
 * Library hides from All Media, so a support conversation full of screenshots does not bury the
 * images someone put on the site.
 *
 * The media row itself is written by the plugin's server route, not from here: most visitors are
 * anonymous, and public.media only accepts inserts from someone with upload_files. The route
 * checks the session token first, then writes the row with the secret key. On a host with no
 * plugin API the upload still works and the file is simply not in the library.
 */

/** Chat uploads are one-handed, on a phone, mid-conversation: the limit is deliberately low. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export const ACCEPTED_ATTACHMENT_TYPES = 'image/*,application/pdf,text/plain';

const isAccepted = (file: File) =>
  file.type.startsWith('image/') || file.type === 'application/pdf' || file.type === 'text/plain';

/** Why a file cannot be sent, or '' when it can. */
export const attachmentProblem = (file: File): string => {
  if (!isAccepted(file)) {
    return `“${file.name}” cannot be sent here. Attach an image, a PDF or a plain text file.`;
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return `“${file.name}” is ${(file.size / 1048576).toFixed(1)} MB. The limit for a chat attachment is ${MAX_ATTACHMENT_BYTES / 1048576} MB.`;
  }
  return '';
};

/**
 * Uploads one file and returns the attachment to put on the message.
 *
 * Cloudinary only: ImageKit uploads need a signature from /api/imagekit-auth, which checks the
 * caller's own upload capability and disk quota, and an anonymous visitor has neither.
 */
export async function uploadChatAttachment(
  file: File,
  credentials: ChatCredentials,
  onProgress: (percent: number) => void = () => {},
): Promise<ChatAttachment> {
  const problem = attachmentProblem(file);
  if (problem) throw new Error(problem);

  const settings = await loadSettings();
  if (!settings.cloudinary_cloud_name || !settings.cloudinary_upload_preset) {
    throw new Error('Attachments are not set up: add the Cloudinary cloud name and unsigned upload preset under Media → Upload settings.');
  }

  const uploaded = await uploadToCloudinary(
    file,
    settings,
    onProgress,
    pluginMediaFolder('rwp-chat', CHAT_MEDIA_FOLDER),
  );

  const attachment: ChatAttachment = {
    url: uploaded.url,
    name: uploaded.file_name || file.name,
    mime_type: uploaded.mime_type,
    bytes: uploaded.bytes,
    width: uploaded.width,
    height: uploaded.height,
    media_id: null,
  };

  try {
    const { media_id: mediaId } = await callChatServer<{ media_id: string | null }>('attachments/record', {
      session_id: credentials.sessionId,
      token: credentials.token,
      attachment: { ...attachment, provider_file_id: uploaded.provider_file_id, provider: uploaded.provider },
    });
    attachment.media_id = mediaId;
  } catch (error) {
    // The file is already at Cloudinary and the visitor can see it; failing the send because the
    // library row could not be written would lose their message for a reason they cannot act on.
    if (!(error instanceof ChatEndpointUnavailableError)) {
      console.warn('The chat attachment was uploaded but not added to the Media Library.', error);
    }
  }

  return attachment;
}
