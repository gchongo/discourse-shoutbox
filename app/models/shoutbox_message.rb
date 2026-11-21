# frozen_string_literal: true

class ShoutboxMessage < ActiveRecord::Base
  belongs_to :user
  belongs_to :reply_to,
             class_name: "ShoutboxMessage",
             optional: true,
             counter_cache: :replies_count
  has_many :shoutbox_replies,
           class_name: "ShoutboxMessage",
           foreign_key: "reply_to_id",
           dependent: :delete_all
  has_many :shoutbox_likes, dependent: :delete_all

  validates :user_id, presence: true
  validates :message, presence: true
  validate :message_length_within_limit
  validates :color,
            format: { with: /\A#[0-9a-fA-F]{3,8}\z/, allow_nil: true, allow_blank: true }

  # Newest first; the controller reverses for display.
  scope :recent, -> { order(id: :desc) }

  # #tags are parsed out of the message text itself (memos-style): the text
  # keeps them, the column powers the tag filter and the tags side card.
  before_validation :extract_tags

  # Keep upload_references in sync with the upload:// short urls embedded in
  # the message text. Without a reference row, core's hourly CleanUpUploads
  # job treats a shoutbox-only image as an orphan once it outlives
  # clean_orphan_uploads_grace_period_hours (default 168h) and deletes the
  # Upload record AND its file from disk — exactly what wiped the board's
  # early images on 2026-11-18. Regular posts get this protection via Post's
  # own sync; this table is plugin-owned storage, so the model does it here.
  after_save :sync_upload_references
  before_destroy :purge_upload_references

  TAG_RE = /#([a-zA-Z0-9_\-]{1,40})/

  UPLOAD_SHORT_URL_RE = %r{upload://[a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)?}

  # ![alt](upload://… / https://…) image markdown — doesn't count toward the
  # visible-text length limit
  IMAGE_MD_RE = /!\[[^\]\n]*\]\([^)\s]+(?:\s[^)]*)?\)/

  def self.extract_tags(text)
    text.to_s.scan(TAG_RE).flatten.map(&:downcase).uniq.first(10)
  end

  # Every message id in the tree rooted at root_id — replies nest, and the
  # parent's dependent: :delete_all hard-deletes children without running
  # their destroy callbacks, so callers purge references for whole subtrees
  # up front instead of relying on per-row hooks.
  def self.subtree_ids(root_id)
    ids = [root_id]
    frontier = [root_id]
    until frontier.empty?
      frontier = ShoutboxMessage.where(reply_to_id: frontier).where.not(id: ids).pluck(:id)
      ids.concat(frontier)
    end
    ids
  end

  private

  # resolve each embedded short url to its Upload and rewrite the target's
  # reference set: ensure_exist! inserts the missing rows and prunes the ones
  # for images an edit just removed
  def sync_upload_references
    upload_ids =
      message
        .to_s
        .scan(UPLOAD_SHORT_URL_RE)
        .filter_map { |url| Upload.find_by(sha1: Upload.sha1_from_short_url(url))&.id }
        .uniq
    UploadReference.ensure_exist!(upload_ids: upload_ids, target: self)
  end

  def purge_upload_references
    UploadReference
      .where(target_type: self.class.name, target_id: self.class.subtree_ids(id))
      .delete_all
  end

  def message_length_within_limit
    visible = message.to_s.gsub(IMAGE_MD_RE, "")
    if visible.length > SiteSetting.shoutbox_max_length
      errors.add(:message, :too_long, count: SiteSetting.shoutbox_max_length)
    end
  end

  def extract_tags
    self.tags = self.class.extract_tags(message)
  end

  # Keeps the table bounded: removes everything below the newest N messages.
  # delete_all skips destroy callbacks, so the doomed rows' upload
  # references are purged here first — otherwise they'd linger and protect
  # uploads nobody can see anymore.
  def self.trim_overflow!
    max = SiteSetting.shoutbox_max_stored
    return if max <= 0

    cutoff_id = ShoutboxMessage.order(id: :desc).limit(1).offset(max - 1).pick(:id)
    return unless cutoff_id

    doomed_ids = ShoutboxMessage.where("id < ?", cutoff_id).pluck(:id)
    return if doomed_ids.empty?

    UploadReference.where(target_type: name, target_id: doomed_ids).delete_all
    ShoutboxMessage.where(id: doomed_ids).delete_all
  end
end
