# frozen_string_literal: true

# name: discourse-shoutbox
# about: A real message board (shoutbox) with plugin-backed storage, live updates
#        via MessageBus and flexible placement (homepage panel, sidebar link,
#        mount-anywhere widget).
# version: 1.0.0
# authors: gchongo
# url: https://github.com/gchongo/discourse-shoutbox

enabled_site_setting :shoutbox_enabled

register_asset "stylesheets/common/shoutbox.scss"

%w[
  paper-plane
  face-smile
  plus
  xmark
  arrow-up-right-from-square
  compass
  bold
  italic
  heading
  list-ul
  far-image
  reply
  heart
  far-heart
  quote-right
  link
  ellipsis-vertical
  thumbtack
  pencil
  far-comment
  repeat
  chart-column
  share
].each { |name| register_svg_icon(name) }

module ::DiscourseShoutbox
  PLUGIN_NAME = "discourse-shoutbox"

  # All live updates for every mounted widget flow through this channel.
  MESSAGE_BUS_CHANNEL = "/shoutbox"

  # Notification type ids: well above core's, unique among the plugins on
  # this install. The client registers render directors for these names.
  NOTIFICATION_TYPES = {
    shoutbox_reply: 1101,
    shoutbox_like: 1102,
    shoutbox_mention: 1103,
  }.freeze

  def self.notify!(user, type, acting_user, message)
    return if user.nil? || acting_user.nil? || user.id == acting_user.id
    Notification.create!(
      user: user,
      notification_type: Notification.types[type],
      data: {
        display_username: acting_user.username,
        topic_title: message.message.to_s[0, 120],
        url: "/shoutbox#m-#{message.id}",
      }.to_json,
    )
  rescue StandardError => e
    Rails.logger.warn("[discourse-shoutbox] notification failed: #{e}")
  end

  # Standalone gate: the shoutbox no longer depends on any other plugin's
  # master switch.
  def self.enabled?
    SiteSetting.shoutbox_enabled
  end
end

after_initialize do
  # notification type ids (client renderers: initializers/shoutbox.js)
  ::DiscourseShoutbox::NOTIFICATION_TYPES.each do |type, id|
    Notification.types[type] = id
  end

  add_to_class(:guardian, :can_post_shoutbox?) do
    authenticated? && user.trust_level.to_i >= SiteSetting.shoutbox_min_trust_level
  end

  add_to_class(:guardian, :can_delete_shoutbox_message?) do |message|
    user&.staff? || message.user_id == user&.id
  end

  # Paths are relative to this plugin.rb (require_relative "…/app/..." with a
  # leading ../ would escape the plugin directory).
  %w[
    app/models/shoutbox_message
    app/models/shoutbox_like
    app/serializers/shoutbox_message_serializer
    app/controllers/discourse_shoutbox/shoutbox_messages_controller
  ].each { |path| require_relative path }

  # Plain scoped routes instead of a mounted Rails engine — mounting engines
  # from a plugin's after_initialize breaks (the "Invalid route name, already
  # in use" error; the same pattern jtechtools uses for its sub-features).
  #
  # HTML requests for "/" serve the Ember app shell (the shoutbox route-map
  # registers the /shoutbox page); JSON requests return the message list.
  Discourse::Application.routes.append do
    scope "shoutbox", module: "discourse_shoutbox", as: "shoutbox" do
      get "/" => "shoutbox_messages#index"
      # full-page loads of /shoutbox/m/:id (refresh, new tab, shared link) need
      # the Ember shell too — the client route picks the id out of the URL
      get "/m/:id" => "shoutbox_messages#index",
          constraints: { id: /\d+/ }
      get "/messages" => "shoutbox_messages#index", defaults: { format: :json }
      get "/messages/:id" => "shoutbox_messages#show", defaults: { format: :json }
      post "/messages" => "shoutbox_messages#create", defaults: { format: :json }
      post "/uploads" => "shoutbox_messages#upload", defaults: { format: :json }
      put "/messages/:id" => "shoutbox_messages#update", defaults: { format: :json }
      post "/messages/:id/like" => "shoutbox_messages#like", defaults: { format: :json }
      post "/messages/:id/pin" => "shoutbox_messages#pin", defaults: { format: :json }
      post "/messages/:id/view" => "shoutbox_messages#view", defaults: { format: :json }
      get "/tags" => "shoutbox_messages#tags", defaults: { format: :json }
      delete "/messages/:id" => "shoutbox_messages#destroy", defaults: { format: :json }
    end
  end
end
