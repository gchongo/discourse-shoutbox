# frozen_string_literal: true

# name: discourse-shoutbox
# about: A real message board (shoutbox) with plugin-backed storage, live updates
#        via MessageBus and flexible placement (homepage panel, sidebar link,
#        mount-anywhere widget).
# version: 0.1.0
# authors: gchongo
# url: https://github.com/gchongo/discourse-shoutbox

enabled_site_setting :shoutbox_enabled

module ::DiscourseShoutbox
  PLUGIN_NAME = "discourse-shoutbox"

  # All live updates for every mounted widget flow through this channel.
  MESSAGE_BUS_CHANNEL = "/shoutbox"
end

require_relative "lib/discourse_shoutbox/engine"

register_asset "stylesheets/common/shoutbox.scss"

register_svg_icon "paper-plane"
register_svg_icon "face-smile"
register_svg_icon "xmark"
register_svg_icon "arrow-up-right-from-square"

after_initialize do
  %w[
    ../app/models/shoutbox_message
    ../app/serializers/shoutbox_message_serializer
    ../app/controllers/discourse_shoutbox/shoutbox_messages_controller
  ].each { |path| require_relative path }

  DiscourseShoutbox::Engine.routes.draw do
    # HTML requests for "/" serve the Ember app shell (the frontend route-map
    # registers the /shoutbox page); JSON requests return the message list.
    get "/" => "shoutbox_messages#index"
    get "/messages" => "shoutbox_messages#index", defaults: { format: :json }
    post "/messages" => "shoutbox_messages#create", defaults: { format: :json }
    delete "/messages/:id" => "shoutbox_messages#destroy", defaults: { format: :json }
  end

  Discourse::Application.routes.append do
    mount DiscourseShoutbox::Engine, at: "/shoutbox", as: "discourse_shoutbox"
  end

  add_to_class(:guardian, :can_post_shoutbox?) do
    authenticated? && user.trust_level.to_i >= SiteSetting.shoutbox_min_trust_level
  end

  add_to_class(:guardian, :can_delete_shoutbox_message?) do |message|
    user&.staff? || message.user_id == user&.id
  end
end
